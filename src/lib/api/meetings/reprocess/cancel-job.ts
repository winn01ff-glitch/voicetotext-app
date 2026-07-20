import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { jobId } = await req.json();
    if (!jobId) {
      return NextResponse.json({ error: "Thiếu jobId" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data: job, error: fetchError } = await supabase
      .from("ai_jobs")
      .select("meeting_id")
      .eq("id", jobId)
      .single();

    if (fetchError || !job) {
      console.error("[Cancel Job] Fetch error:", fetchError);
      return NextResponse.json({ error: "Không tìm thấy tác vụ" }, { status: 404 });
    }

    // Model 2-bản: huỷ = đánh dấu mọi job queued/processing của meeting là "cancelled".
    // Worker kiểm checkJobCancelled ở từng batch → tự dừng. Job "process" chỉ ghi transcripts
    // khi chạy XONG toàn bộ, nên huỷ giữa chừng không đụng dữ liệu đang hiển thị (không cần rollback).
    const { error } = await supabase
      .from("ai_jobs")
      .update({ status: "cancelled", progress: 0, ended_at: new Date().toISOString() })
      .eq("meeting_id", job.meeting_id)
      .in("status", ["queued", "processing"]);

    if (error) {
      console.error("[Cancel Job] Error:", error);
      return NextResponse.json({ error: "Không thể huỷ các tác vụ" }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: "Đã huỷ toàn bộ tiến trình thành công" });
  } catch (error: any) {
    console.error("[Cancel Job API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
