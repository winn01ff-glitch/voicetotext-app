import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PipelineConfig } from "@/lib/ai/pipeline";
import { reDiarizeMeeting } from "@/lib/ai/processPipeline";

/**
 * Re-diarize NHẸ: chỉ gán lại người nói trên transcript ĐÃ CÓ (đổi nhãn / tách độc thoại / AI theo
 * tên|vai trò|gộp) — GIỮ nguyên nội dung + bản dịch, KHÔNG bóc băng lại, KHÔNG dịch lại.
 * Chạy đồng bộ (nhanh: 0–1 lượt gọi AI) → hợp serverless, không cần job queue.
 */
export async function POST(request: Request) {
  try {
    const { meetingId, mode } = await request.json();
    if (!meetingId) {
      return NextResponse.json({ error: "Thiếu meetingId." }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data: meeting } = await supabase
      .from("meetings")
      .select("title, source_language, target_language, meeting_context")
      .eq("id", meetingId)
      .single();
    const { data: speakers } = await supabase.from("speakers").select("*").eq("meeting_id", meetingId);
    const { data: glossary } = await supabase.from("glossary").select("*").eq("meeting_id", meetingId);

    const config: PipelineConfig = {
      title: meeting?.title || "Meeting",
      meetingContext: meeting?.meeting_context || "",
      sourceLanguage: meeting?.source_language || "auto",
      targetLanguage: meeting?.target_language || "vi",
      speakers: speakers || [],
      glossary: glossary || [],
    };

    await reDiarizeMeeting(meetingId, config, mode ?? null);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Re-diarize error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
