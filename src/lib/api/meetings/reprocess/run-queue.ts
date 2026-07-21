import { NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";

export async function POST(req: Request) {
  try {
    const { meetingId, jobTypes, mode } = await req.json();

    if (!meetingId || !jobTypes || !Array.isArray(jobTypes)) {
      return NextResponse.json({ error: "Thiếu tham số bắt buộc" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // Clear old AI chunk cache if reprocessing "process" job to ensure fresh Gemini run
    if (jobTypes.includes("process")) {
      await supabase.from("pipeline_cache").delete().eq("meeting_id", meetingId);
    }

    // Reset status of ai_summaries if summary is queued
    if (jobTypes.includes("summary")) {
      await supabase.from("ai_summaries").update({ status: "Draft" }).eq("meeting_id", meetingId);
    }

    // Skips job types that already have a queued/processing row for this meeting —
    // avoids two overlapping runs (e.g. auto-enqueue on end-meeting + manual click).
    const enqueuedTypes = await enqueueAiJobs(meetingId, jobTypes, mode || null);

    if (enqueuedTypes.length === 0) {
      return NextResponse.json({ success: true, message: "Các job này đã đang chạy hoặc đang chờ." });
    }

    // Runs after the response is sent, kept alive past the request lifecycle
    // (Next.js `after()` — uses the platform's waitUntil under the hood on Vercel).
    after(() => runAIJobsQueue(meetingId).catch((err) => {
      console.error("[QueueWorker] Background error:", err);
    }));

    return NextResponse.json({ success: true, message: "Đã đưa vào hàng đợi xử lý ngầm" });
  } catch (error: any) {
    console.error("[Run Queue API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
