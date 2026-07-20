import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { deleteMeetingAudio } from "@/lib/supabase/supabase-storage";

export const dynamic = "force-dynamic";

const RETENTION_DAYS = 7;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    // === Action: cleanup-audio ===
    // GET /api/keep-alive?action=cleanup-audio&secret=CRON_SECRET
    // Tự động xóa audio files cũ hơn 7 ngày khỏi Supabase Storage.
    if (action === "cleanup-audio") {
      const secret = searchParams.get("secret");
      const expectedSecret = process.env.CRON_SECRET;
      if (!expectedSecret || secret !== expectedSecret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const supabase = await createServerSupabaseClient();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

      const { data: expiredMeetings, error: queryError } = await supabase
        .from("meetings")
        .select("id, audio_url, created_at")
        .not("audio_url", "is", null)
        .lt("created_at", cutoffDate.toISOString());

      if (queryError) {
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

      let deletedCount = 0;
      const errors: string[] = [];

      for (const meeting of expiredMeetings) {
        try {
          await deleteMeetingAudio(meeting.audio_url);
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

      return NextResponse.json({
        message: `Cleaned up ${deletedCount} audio files`,
        deleted: deletedCount,
        total_expired: expiredMeetings.length,
        retention_days: RETENTION_DAYS,
        ...(errors.length > 0 ? { errors } : {}),
      });
    }

    // === Default: keep-alive ping ===
    const supabase = await createServerSupabaseClient();
    const { count, error } = await supabase
      .from("meetings")
      .select("*", { count: "exact", head: true });

    if (error) throw error;

    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      meetingsCount: count,
    });
  } catch (error) {
    console.error("Keep-alive error:", error);
    return NextResponse.json(
      { status: "error", message: String(error) },
      { status: 500 }
    );
  }
}
