import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runPipeline, determineCheckpoint, PipelineConfig } from "@/lib/ai/pipeline";

/**
 * Resume job từ chỗ dừng (failed hoặc cancelled)
 * Đọc pipeline_results + raw_deepgram_result để xác định checkpoint
 * Chạy tiếp pipeline từ bước đó, KHÔNG gọi lại Deepgram cho chunk đã xong
 */
export async function POST(request: Request) {
  try {
    const { meeting_id } = await request.json();

    if (!meeting_id) {
      return NextResponse.json(
        { error: "Thiếu meeting_id." },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();

    // Lấy meeting data
    const { data: meeting, error: fetchError } = await supabase
      .from("meetings")
      .select("*")
      .eq("id", meeting_id)
      .single();

    if (fetchError || !meeting) {
      return NextResponse.json(
        { error: "Không tìm thấy cuộc họp." },
        { status: 404 }
      );
    }

    // Chỉ cho phép resume khi failed hoặc cancelled
    if (!["failed", "cancelled"].includes(meeting.status)) {
      return NextResponse.json(
        { error: `Không thể tiếp tục cuộc họp ở trạng thái "${meeting.status}".` },
        { status: 400 }
      );
    }

    // Xác định checkpoint
    const checkpoint = determineCheckpoint(
      meeting.pipeline_results,
      meeting.raw_deepgram_result
    );

    // Lấy speakers và glossary
    const [{ data: speakers }, { data: glossary }] = await Promise.all([
      supabase.from("speakers").select("*").eq("meeting_id", meeting_id).eq("is_reprocessed", false),
      supabase.from("glossary").select("*").eq("meeting_id", meeting_id),
    ]);

    const pipelineConfig: PipelineConfig = {
      title: meeting.title,
      meetingContext: meeting.meeting_context || "general",
      sourceLanguage: meeting.source_language || "auto",
      targetLanguage: meeting.target_language,
      speakers: (speakers || []).map((s: any) => ({
        speaker_tag: s.speaker_tag,
        display_name: s.display_name,
        language_code: s.language_code,
      })),
      glossary: (glossary || []).map((g: any) => ({
        source: g.source,
        target: g.target,
        source_language: g.source_language,
        target_language: g.target_language,
      })),
    };

    // Set status để bắt đầu resume
    await supabase
      .from("meetings")
      .update({
        status: checkpoint,
        progress: { percent: 0, message: `Tiếp tục từ bước: ${checkpoint}...` },
      })
      .eq("id", meeting_id);

    // Chạy pipeline trong background từ checkpoint
    after(async () => {
      try {
        // Resume: không cần audio buffer vì raw_deepgram_result đã có
        await runPipeline(meeting_id, null as any, pipelineConfig, checkpoint);
      } catch (error) {
        console.error(`[Resume Pipeline Error] Meeting ${meeting_id}:`, error);
      }
    });

    return NextResponse.json({
      status: "success",
      checkpoint,
      message: `Đang tiếp tục xử lý từ bước "${checkpoint}".`,
    });
  } catch (error) {
    console.error("Resume job error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
