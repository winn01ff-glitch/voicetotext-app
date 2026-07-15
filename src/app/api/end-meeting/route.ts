import { NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { runAIJobsQueue } from "@/lib/ai/queueWorker";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, duration_ms, transcripts, raw_transcript } = body;

    if (!meeting_id) {
      return NextResponse.json({ error: "Missing meeting_id" }, { status: 400 });
    }


    const supabase = await createServerSupabaseClient();

    // 0. Fetch meeting configuration first to get languages
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("target_language, source_language")
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

    // 2. Fetch or create speakers and insert transcripts
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

    // Model 2-bản: cuộc họp trực tiếp đã xử lý AI real-time trong lúc ghi (sửa/dịch), nên các
    // utterance này CHÍNH LÀ bản đã-xử-lý. Lưu thẳng vào transcripts (không versioning). RAW blob
    // giữ ở meetings.raw_transcript. Chỉ cần chạy job "summary".
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

      // Chỉ cần tóm tắt (nội dung đã xử lý real-time).
      try {
        const enqueuedTypes = await enqueueAiJobs(meeting_id, ["summary"]);
        if (enqueuedTypes.length > 0) {
          after(() => runAIJobsQueue(meeting_id).catch((err) => console.error("[QueueWorker] Background error:", err)));
        }
      } catch (err) {
        console.error("Failed to auto-enqueue AI jobs:", err);
      }
    }

    // Update meeting status to completed
    const { error: updateMeetingCompletedError } = await supabase
      .from("meetings")
      .update({ status: "completed" })
      .eq("id", meeting_id);

    if (updateMeetingCompletedError) throw updateMeetingCompletedError;

    return NextResponse.json({
      status: "success",
    });
  } catch (error) {
    console.error("End meeting error:", error);
    // Attempt to set meeting status to failed on database in case of severe exception
    try {
      const body = await request.json().catch(() => ({}));
      if (body.meeting_id) {
        const supabase = await createServerSupabaseClient();
        await supabase.from("meetings").update({ status: "failed" }).eq("id", body.meeting_id);
        await supabase.from("ai_summaries").update({ status: "Draft" }).eq("meeting_id", body.meeting_id);
      }
    } catch {}

    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
