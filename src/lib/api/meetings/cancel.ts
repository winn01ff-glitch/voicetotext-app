import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Hủy job đang xử lý
 * Worker sẽ tự dừng ở checkpoint tiếp theo (checkCancelled() trước mỗi step/chunk)
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

    // Kiểm tra meeting tồn tại và đang xử lý
    const { data: meeting, error: fetchError } = await supabase
      .from("meetings")
      .select("id, status, progress")
      .eq("id", meeting_id)
      .single();

    if (fetchError || !meeting) {
      return NextResponse.json(
        { error: "Không tìm thấy cuộc họp." },
        { status: 404 }
      );
    }

    // Chỉ cho phép hủy khi đang xử lý ("processing" = giai đoạn AI jobs)
    const processingStatuses = [
      "queued", "uploading", "transcribing", "processing", "correcting",
      "diarizing", "checking", "translating", "summarizing",
      "extracting", "saving",
    ];

    if (!processingStatuses.includes(meeting.status)) {
      return NextResponse.json(
        { error: `Không thể hủy cuộc họp ở trạng thái "${meeting.status}".` },
        { status: 400 }
      );
    }

    // Set status = cancelled (giữ percent hiện tại để nút "Tiếp tục" hiển thị đúng chỗ dừng)
    // Worker pipeline sẽ phát hiện ở checkCancelled() tiếp theo
    const { error: updateError } = await supabase
      .from("meetings")
      .update({
        status: "cancelled",
        progress: {
          ...(meeting.progress || {}),
          message: "Đã hủy bởi người dùng.",
          updated_at: new Date().toISOString(),
        },
      })
      .eq("id", meeting_id);

    if (updateError) throw updateError;

    // Hủy cả AI jobs đang chờ/chạy — worker queue check ai_jobs.status nên nếu không
    // set ở đây, job Gemini vẫn tiếp tục chạy ngầm sau khi meeting đã cancelled.
    await supabase
      .from("ai_jobs")
      .update({ status: "cancelled", ended_at: new Date().toISOString() })
      .eq("meeting_id", meeting_id)
      .in("status", ["queued", "processing"]);

    return NextResponse.json({
      status: "success",
      message: "Đã gửi yêu cầu hủy. Quá trình xử lý sẽ dừng ở bước tiếp theo.",
    });
  } catch (error) {
    console.error("Cancel job error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
