import { NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import fs from "fs";
import path from "path";
import { runPipeline, PipelineConfig } from "@/lib/ai/pipeline";

import { runAIJobsQueue } from "@/lib/ai/queueWorker";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";

export async function POST(request: Request) {
  // Giữ meeting_id ngoài try: body chỉ đọc được một lần, catch không thể json() lại.
  let meetingIdForError: string | null = null;
  try {
    const body = await request.json();
    const { meeting_id, duration_ms, transcripts, raw_transcript } = body;

    if (!meeting_id) {
      return NextResponse.json({ error: "Missing meeting_id" }, { status: 400 });
    }
    meetingIdForError = meeting_id;


    const supabase = await createServerSupabaseClient();

    // 0. Fetch meeting configuration first to get languages
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("title, meeting_context, target_language, source_language")
      .eq("id", meeting_id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // 1. Update meeting status to processing
    const { error: updateStatusError } = await supabase
      .from("meetings")
      .update({
        status: "processing",
        duration_ms: duration_ms || 0,
        raw_transcript: raw_transcript || "",
      })
      .eq("id", meeting_id);

    if (updateStatusError) throw updateStatusError;

    // Update AI Summary table status to Generating
    await supabase
      .from("ai_summaries")
      .update({ status: "Generating" })
      .eq("meeting_id", meeting_id);

    // 2. Fetch or create speakers and insert transcripts FIRST
    const { data: existingSpeakers } = await supabase
      .from("speakers")
      .select("id, speaker_tag, display_name")
      .eq("meeting_id", meeting_id);

    const speakerTagToId: Record<string, string> = {};
    const speakerTagToName: Record<string, string> = {};
    if (existingSpeakers) {
      existingSpeakers.forEach((s: any) => {
        speakerTagToId[s.speaker_tag] = s.id;
        speakerTagToName[s.speaker_tag] = s.display_name;
      });
    }

    // Create missing speakers in DB
    const uniqueSpeakerTags = Array.from(
      new Set((transcripts || []).map((t: any) => t.speakerTag).filter(Boolean))
    );

    for (const tag of uniqueSpeakerTags as string[]) {
      if (!speakerTagToName[tag]) {
        speakerTagToName[tag] = tag === "speaker_1" ? "Speaker 1" : tag.replace("speaker_", "Speaker ");
      }
      const name = speakerTagToName[tag];
      if (!speakerTagToId[tag]) {
        const { data: newSpeaker } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag: tag,
            display_name: name,
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select()
          .single();
        if (newSpeaker) {
          speakerTagToId[tag] = newSpeaker.id;
          speakerTagToName[tag] = newSpeaker.display_name;
        }
      }
    }

    if ((transcripts || []).length > 0) {
      // Xoá dòng cũ (tránh trùng nếu end-meeting gọi nhiều lần) rồi ghi mới.
      await supabase.from("transcripts").delete().eq("meeting_id", meeting_id);

      const insertRows = transcripts.map((t: any) => ({
        meeting_id,
        speaker_id: speakerTagToId[t.speakerTag] || null,
        original_text: t.correctedText || t.text,
        translated_text: t.translatedText || null,
        start_ms: t.startMs,
        end_ms: t.endMs,
        confidence: t.confidence || 1.0,
        speaker_tag: t.speakerTag,
        speaker_name: speakerTagToName[t.speakerTag] || t.speakerTag,
      }));

      const { error: insertError } = await supabase.from("transcripts").insert(insertRows);
      if (insertError) throw insertError;
    }

    // 3. Kiểm tra xem file âm thanh ghi âm live có tồn tại trên server không
    const audioDir = path.join(process.cwd(), "public", "audio");
    let audioFile: string | undefined = undefined;
    if (fs.existsSync(audioDir)) {
      const files = fs.readdirSync(audioDir);
      audioFile = files.find((f) => f.startsWith(`${meeting_id}.`));
    }

    if (audioFile) {
      console.log(`[End Meeting] Audio file found: ${audioFile}. Running reprocess pipeline...`);
      const audioBuffer = fs.readFileSync(path.join(audioDir, audioFile));

      // Fetch speakers and glossary từ Supabase để chuyển cấu hình vào pipeline
      const { data: dbSpeakers } = await supabase
        .from("speakers")
        .select("speaker_tag, display_name, language_code, color_hex")
        .eq("meeting_id", meeting_id);

      const { data: dbGlossary } = await supabase
        .from("glossary")
        .select("source, target, source_language, target_language")
        .eq("meeting_id", meeting_id);

      const pipelineConfig: PipelineConfig = {
        title: meeting.title || "Live Meeting",
        meetingContext: meeting.meeting_context || "general",
        sourceLanguage: meeting.source_language || "auto",
        targetLanguage: meeting.target_language,
        speakers: dbSpeakers ? dbSpeakers.map((s: any) => ({
          speaker_tag: s.speaker_tag,
          display_name: s.display_name,
          language_code: s.language_code || "auto",
          color_hex: s.color_hex,
        })) : [],
        glossary: dbGlossary ? dbGlossary.map((g: any) => ({
          source: g.source,
          target: g.target,
          source_language: g.source_language || "auto",
          target_language: g.target_language || meeting.target_language,
        })) : [],
      };

      // Chạy pipeline xử lý lại ngầm
      after(async () => {
        try {
          // Bóc băng lại -> lưu RAW deepgram
          await runPipeline(meeting_id, audioBuffer, pipelineConfig);
          // Đăng ký job process (AI phân vai + dịch thuật chất lượng cao) & summary (tóm tắt)
          await enqueueAiJobs(meeting_id, ["process", "summary"]);
          // Chạy hàng đợi job
          await runAIJobsQueue(meeting_id);
        } catch (pipelineErr) {
          console.error(`[End Meeting Reprocess Error] for meeting ${meeting_id}:`, pipelineErr);
        }
      });

      return NextResponse.json({
        status: "success",
        reprocessed: true,
      });
    }

    // --- CƠ CHẾ DỰ PHÒNG (FALLBACK): KHÔNG CÓ FILE ÂM THANH -> LƯU THẲNG LIVE TRANSCRIPTS (ĐÃ LƯU Ở TRÊN), CHỈ CHẠY SUMMARY ---
    try {
      const enqueuedTypes = await enqueueAiJobs(meeting_id, ["summary"]);
      if (enqueuedTypes.length > 0) {
        after(() => runAIJobsQueue(meeting_id).catch((err) => console.error("[QueueWorker] Background error:", err)));
      }
    } catch (err) {
      console.error("Failed to auto-enqueue AI jobs:", err);
    }

    // Update meeting status to completed
    const { error: updateMeetingCompletedError } = await supabase
      .from("meetings")
      .update({ status: "completed" })
      .eq("id", meeting_id);

    if (updateMeetingCompletedError) throw updateMeetingCompletedError;

    return NextResponse.json({
      status: "success",
      reprocessed: false,
    });
  } catch (error) {
    console.error("End meeting error:", error);
    // Attempt to set meeting status to failed on database in case of severe exception
    try {
      if (meetingIdForError) {
        const supabase = await createServerSupabaseClient();
        await supabase.from("meetings").update({ status: "failed" }).eq("id", meetingIdForError);
        await supabase.from("ai_summaries").update({ status: "Draft" }).eq("meeting_id", meetingIdForError);
      }
    } catch {}

    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
