import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";

export async function POST(req: Request) {
  try {
    const { meetingId, jobTypes } = await req.json();

    if (!meetingId || !jobTypes || !Array.isArray(jobTypes)) {
      return NextResponse.json({ error: "Thiếu tham số bắt buộc" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // Reset status of ai_summaries if summary is queued
    if (jobTypes.includes("summary")) {
      await supabase.from("ai_summaries").update({ status: "Draft" }).eq("meeting_id", meetingId);
    }

    // Prepare jobs to enqueue
    const jobs = jobTypes.map((type) => ({
      meeting_id: meetingId,
      type,
      status: "queued",
      progress: 0,
      retry_count: 0,
      max_retries: 3
    }));

    // Check if these jobs are already queued or processing (to avoid duplicates)
    // Actually, simple enqueue is fine. The user might have clicked [Regenerate].
    
    // Insert into ai_jobs
    const { error: insertErr } = await supabase.from("ai_jobs").insert(jobs);
    
    if (insertErr) {
      console.error("[Run Queue] Insert error:", insertErr);
      return NextResponse.json({ error: "Không thể thêm vào hàng đợi" }, { status: 500 });
    }

    // Trigger background worker (floating promise)
    // In production Vercel, consider using Inngest / Upstash QStash, or waitUntil(runAIJobsQueue(meetingId))
    runAIJobsQueue(meetingId).catch(err => {
      console.error("[QueueWorker] Background error:", err);
    });

    return NextResponse.json({ success: true, message: "Đã đưa vào hàng đợi xử lý ngầm" });
  } catch (error: any) {
    console.error("[Run Queue API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
