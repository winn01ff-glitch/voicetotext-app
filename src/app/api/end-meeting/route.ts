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
      .eq("meeting_id", meeting_id)
      .eq("is_active", true);

    // 2. Fetch or create speakers and insert transcripts
    const { data: existingSpeakers } = await supabase
      .from("speakers")
      .select("id, speaker_tag")
      .eq("meeting_id", meeting_id);

    const speakerTagToId: Record<string, string> = {};
    if (existingSpeakers) {
      existingSpeakers.forEach((s: any) => {
        speakerTagToId[s.speaker_tag] = s.id;
      });
    }

    // Create missing speakers in DB
    const uniqueSpeakerTags = Array.from(
      new Set((transcripts || []).map((t: any) => t.speakerTag).filter(Boolean))
    );

    for (const tag of uniqueSpeakerTags as string[]) {
      if (!speakerTagToId[tag]) {
        const { data: newSpeaker } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag: tag,
            display_name: tag === "speaker_1" ? "Tôi" : tag.replace("speaker_", "Speaker "),
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select()
          .single();
        if (newSpeaker) {
          speakerTagToId[tag] = newSpeaker.id;
        }
      }
    }

    // Insert transcripts to DB
    // Nội dung ở đây đã qua AI (process-transcript-batch) trong lúc họp live,
    // không phải Deepgram thô, nên đánh dấu FINAL thay vì để rơi vào RAW mặc định.
    if ((transcripts || []).length > 0) {
      // Deactivate any existing transcripts for this meeting first
      // (prevents duplicates if end-meeting is called multiple times)
      await supabase.from("transcripts").update({ is_active: false }).eq("meeting_id", meeting_id);

      // Find next version number
      const { data: maxVerData } = await supabase
        .from("transcripts")
        .select("version")
        .eq("meeting_id", meeting_id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextVersion = (maxVerData?.version || 0) + 1;

      const insertRows = transcripts.map((t: any) => ({
        meeting_id,
        speaker_id: speakerTagToId[t.speakerTag] || null,
        original_text: t.text,
        corrected_text: t.correctedText || t.text,
        translated_text: t.translatedText,
        translation_language: meeting.target_language || "vi",
        translation_provider: "Gemini",
        start_ms: t.startMs,
        end_ms: t.endMs,
        confidence: t.confidence || 1.0,
        version_type: "FINAL",
        version: nextVersion,
        is_active: true,
      }));

      const { error: insertError } = await supabase
        .from("transcripts")
        .insert(insertRows);
      if (insertError) throw insertError;
    }

    // Auto-enqueue background AI pipeline (spellcheck → speaker → translation → summary).
    // All AI processing is handled by the queue worker using the saved transcripts.
    if ((transcripts || []).length > 0) {
      try {
        const enqueuedTypes = await enqueueAiJobs(meeting_id, ["spellcheck", "speaker", "translation", "summary"]);
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
