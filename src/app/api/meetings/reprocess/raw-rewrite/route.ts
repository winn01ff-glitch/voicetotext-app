import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { step1_correctSTT } from "@/lib/ai/pipeline";

async function getMeetingConfig(meetingId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: meeting } = await supabase
    .from("meetings")
    .select("title, source_language, target_language, meeting_context")
    .eq("id", meetingId)
    .single();

  const { data: glossary } = await supabase
    .from("glossary")
    .select("*")
    .eq("meeting_id", meetingId);

  const { data: speakers } = await supabase
    .from("speakers")
    .select("*")
    .eq("meeting_id", meetingId)
    .eq("is_active", true);

  return {
    title: meeting?.title || "Meeting",
    meetingContext: meeting?.meeting_context || "",
    sourceLanguage: meeting?.source_language || "auto",
    targetLanguage: meeting?.target_language || "vi",
    glossary: glossary || [],
    speakers: speakers || [],
  };
}

export async function POST(req: Request) {
  try {
    const { meetingId, mode } = await req.json();

    if (!meetingId) {
      return NextResponse.json({ error: "Thiếu tham số bắt buộc" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Fetch raw transcripts (version_type === "RAW" or "raw")
    const { data: rawTranscripts, error: txError } = await supabase
      .from("transcripts")
      .select("*")
      .eq("meeting_id", meetingId)
      .or("version_type.eq.RAW,version_type.eq.raw")
      .order("start_ms", { ascending: true });

    if (txError) {
      throw txError;
    }

    if (!rawTranscripts || rawTranscripts.length === 0) {
      return NextResponse.json({ success: true, message: "Không tìm thấy bản ghi gốc nào để xử lý" });
    }

    // 2. If mode is null/empty/default, we reset corrected_text to null (falls back to original_text)
    if (!mode) {
      const updates = rawTranscripts.map((t) =>
        supabase
          .from("transcripts")
          .update({ corrected_text: null })
          .eq("id", t.id)
      );
      await Promise.all(updates);
      return NextResponse.json({ success: true, message: "Đã hoàn tác sửa bản gốc về mặc định" });
    }

    // 3. Get full meeting config and call step1_correctSTT
    const config = await getMeetingConfig(meetingId);

    const utterances = rawTranscripts.map((t) => ({
      text: t.original_text || "",
      start: (t.start_ms || 0) / 1000,
      end: (t.end_ms || 0) / 1000,
      speaker: parseInt((t.speaker_tag || "speaker_1").replace("speaker_", "")) - 1,
      confidence: t.confidence || 1.0,
    }));

    const corrected = await step1_correctSTT(utterances, config, mode);

    // 4. Update corrected_text in database for the RAW version
    const updates = rawTranscripts.map((t, idx) => {
      const correctedText = corrected[idx]?.text || t.original_text;
      return supabase
        .from("transcripts")
        .update({ corrected_text: correctedText })
        .eq("id", t.id);
    });

    await Promise.all(updates);

    return NextResponse.json({ success: true, message: "Đã xử lý sửa bản ghi gốc thành công" });
  } catch (error: any) {
    console.error("[Raw Rewrite API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
