import { NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";

/**
 * Tiếp tục xử lý một cuộc họp bị lỗi/huỷ (model 2-bản).
 * RAW (raw_deepgram_result) đã có sẵn → chỉ cần chạy lại job process + summary từ đó.
 * Không còn checkpoint theo pipeline_results (đã bỏ versioning).
 */
export async function POST(request: Request) {
  try {
    const { meeting_id } = await request.json();
    if (!meeting_id) {
      return NextResponse.json({ error: "Thiếu meeting_id." }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data: meeting, error: fetchError } = await supabase
      .from("meetings")
      .select("status, raw_deepgram_result")
      .eq("id", meeting_id)
      .single();

    if (fetchError || !meeting) {
      return NextResponse.json({ error: "Không tìm thấy cuộc họp." }, { status: 404 });
    }

    if (!["failed", "cancelled"].includes(meeting.status)) {
      return NextResponse.json(
        { error: `Không thể tiếp tục cuộc họp ở trạng thái "${meeting.status}".` },
        { status: 400 }
      );
    }

    if (!meeting.raw_deepgram_result) {
      // Lỗi xảy ra ngay ở bước bóc băng → không có RAW để xử lý tiếp, cần tải lại file.
      return NextResponse.json(
        { error: "Chưa có bản ghi thô từ Deepgram — hãy tải lại file âm thanh." },
        { status: 400 }
      );
    }

    await supabase
      .from("meetings")
      .update({ status: "processing", progress: { percent: 40, message: "Tiếp tục xử lý AI..." } })
      .eq("id", meeting_id);

    await enqueueAiJobs(meeting_id, ["process", "summary"]);
    after(() => runAIJobsQueue(meeting_id).catch((err) => console.error("[Resume] Worker error:", err)));

    return NextResponse.json({ status: "success", message: "Đang tiếp tục xử lý AI." });
  } catch (error) {
    console.error("Resume job error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
