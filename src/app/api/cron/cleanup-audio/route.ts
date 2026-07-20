import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { deleteMeetingAudio } from "@/lib/supabase/supabase-storage";

const RETENTION_DAYS = 7;

/**
 * GET /api/cron/cleanup-audio?secret=CRON_SECRET
 *
 * Tự động xóa audio files cũ hơn RETENTION_DAYS ngày khỏi Supabase Storage.
 * Giữ nguyên transcript và meeting metadata — chỉ xóa audio.
 *
 * Trigger: cron-job.org (miễn phí) gọi mỗi ngày lúc 03:00 UTC,
 * hoặc gọi thủ công khi cần dọn dẹp.
 */
export async function GET(request: Request) {
  try {
    // Xác thực bằng secret key đơn giản
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get("secret");
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = await createServerSupabaseClient();

    // Tìm meetings có audio_url và đã quá RETENTION_DAYS ngày
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    const { data: expiredMeetings, error: queryError } = await supabase
      .from("meetings")
      .select("id, audio_url, created_at")
      .not("audio_url", "is", null)
      .lt("created_at", cutoffDate.toISOString());

    if (queryError) {
      console.error("[Cleanup] Query error:", queryError.message);
      return NextResponse.json(
        { error: "Failed to query expired meetings" },
        { status: 500 }
      );
    }

    if (!expiredMeetings || expiredMeetings.length === 0) {
      return NextResponse.json({
        message: "No expired audio to clean up",
        deleted: 0,
        retention_days: RETENTION_DAYS,
      });
    }

    // Xóa từng file và cập nhật DB
    let deletedCount = 0;
    const errors: string[] = [];

    for (const meeting of expiredMeetings) {
      try {
        // Xóa file trong Storage bucket
        const deleted = await deleteMeetingAudio(meeting.audio_url);
        if (!deleted) {
          // File có thể đã bị xóa trước đó — vẫn clear audio_url
          console.warn(
            `[Cleanup] Storage delete failed for ${meeting.id}, clearing audio_url anyway`
          );
        }

        // Xóa audio_url trong DB (dù Storage delete thành công hay không)
        const { error: updateError } = await supabase
          .from("meetings")
          .update({ audio_url: null })
          .eq("id", meeting.id);

        if (updateError) {
          errors.push(`DB update failed for ${meeting.id}: ${updateError.message}`);
        } else {
          deletedCount++;
        }
      } catch (err: any) {
        errors.push(`${meeting.id}: ${err.message}`);
      }
    }

    console.log(
      `[Cleanup] Finished: ${deletedCount}/${expiredMeetings.length} audio files deleted`
    );

    return NextResponse.json({
      message: `Cleaned up ${deletedCount} audio files`,
      deleted: deletedCount,
      total_expired: expiredMeetings.length,
      retention_days: RETENTION_DAYS,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (error: any) {
    console.error("[Cleanup] Unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
