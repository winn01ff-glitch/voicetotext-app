import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Đổi tên speaker — bulk update tất cả dòng transcript có cùng speaker_tag
 * 2 chế độ: 
 *   - rename: đổi tên đơn giản (không gọi AI)
 *   - remap: chạy lại AI speaker mapping (TODO: implement later)
 */
export async function POST(request: Request) {
  try {
    const { meeting_id, speaker_tag, new_name } = await request.json();

    if (!meeting_id || !speaker_tag || !new_name) {
      return NextResponse.json(
        { error: "Thiếu thông tin (meeting_id, speaker_tag, new_name)." },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();

    // 1. Update bảng speakers
    const { error: speakerError } = await supabase
      .from("speakers")
      .update({ display_name: new_name })
      .eq("meeting_id", meeting_id)
      .eq("speaker_tag", speaker_tag);

    if (speakerError) throw speakerError;

    // 2. Bulk update bảng transcripts — tất cả dòng cùng speaker_tag
    const { data: updatedTranscripts, error: transcriptError } = await supabase
      .from("transcripts")
      .update({ speaker_name: new_name })
      .eq("meeting_id", meeting_id)
      .eq("speaker_tag", speaker_tag)
      .select("id");

    if (transcriptError) throw transcriptError;

    return NextResponse.json({
      status: "success",
      updated_count: updatedTranscripts?.length || 0,
      message: `Đã đổi tên "${speaker_tag}" thành "${new_name}" cho ${updatedTranscripts?.length || 0} dòng.`,
    });
  } catch (error) {
    console.error("Rename speaker error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
