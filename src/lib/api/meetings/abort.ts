import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * DỪNG XỬ LÝ — huỷ pipeline và XOÁ SẠCH cuộc họp.
 *
 * Khác với /api/meetings/cancel (chỉ tạm dừng, giữ dữ liệu để "Tiếp tục"), route này
 * bỏ hẳn: cuộc họp biến mất khỏi danh sách, không còn dữ liệu ở backend lẫn file audio.
 * Dùng cho nút "Dừng xử lý" ở màn tiến trình.
 */
export async function POST(request: Request) {
  try {
    const { meeting_id } = await request.json();
    if (!meeting_id) {
      return NextResponse.json({ error: "Thiếu meeting_id." }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data: meeting } = await supabase
      .from("meetings")
      .select("id")
      .eq("id", meeting_id)
      .single();

    if (!meeting) {
      // Đã bị xoá trước đó → coi như thành công (idempotent).
      return NextResponse.json({ status: "success", message: "Cuộc họp không còn tồn tại." });
    }

    // 1. Huỷ job đang chạy TRƯỚC để worker dừng ở checkpoint gần nhất, tránh việc nó
    //    ghi lại dữ liệu sau khi ta đã xoá.
    await supabase
      .from("ai_jobs")
      .update({ status: "cancelled", ended_at: new Date().toISOString() })
      .eq("meeting_id", meeting_id)
      .in("status", ["queued", "processing"]);

    await supabase
      .from("meetings")
      .update({ status: "cancelled" })
      .eq("id", meeting_id);

    // 2. Xoá dữ liệu con. Làm tuần tự theo nhóm để không phụ thuộc ON DELETE CASCADE.
    //    Bảng nào không tồn tại/không có quyền → bỏ qua, không chặn việc xoá meeting.
    const childTables = [
      "transcripts",
      "speakers",
      "glossary",
      "ai_summaries",
      "action_items",
      "ai_jobs",
      "pipeline_cache",
      "meeting_metadata",
      "chat_messages",
      "embeddings",
    ];
    for (const table of childTables) {
      const { error } = await supabase.from(table).delete().eq("meeting_id", meeting_id);
      if (error) {
        console.warn(`[Abort] Bỏ qua bảng ${table}:`, error.message);
      }
    }

    // 3. Xoá bản ghi cuộc họp.
    const { error: delErr } = await supabase.from("meetings").delete().eq("id", meeting_id);
    if (delErr) throw delErr;

    // 4. Xoá file audio trên đĩa (mọi phần mở rộng).
    try {
      const audioDir = path.join(process.cwd(), "public", "audio");
      if (fs.existsSync(audioDir)) {
        for (const f of fs.readdirSync(audioDir)) {
          if (f.startsWith(`${meeting_id}.`)) {
            fs.unlinkSync(path.join(audioDir, f));
            console.log(`[Abort] Đã xoá file audio: ${f}`);
          }
        }
      }
    } catch (fileErr) {
      console.warn("[Abort] Không xoá được file audio:", fileErr);
    }

    return NextResponse.json({ status: "success", message: "Đã dừng và xoá sạch cuộc họp." });
  } catch (error) {
    console.error("Abort meeting error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
