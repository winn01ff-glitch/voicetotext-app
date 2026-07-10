import { createServerSupabaseClient } from "@/lib/supabase/server";

// Shared helper for both the manual "Phân tích toàn diện" trigger and the
// automatic post-meeting enqueue. Skips any job type that already has a
// queued/processing row for this meeting, so the two triggers can't stack
// duplicate/overlapping runs against the same transcript version.
export async function enqueueAiJobs(meetingId: string, jobTypes: string[]): Promise<string[]> {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("ai_jobs")
    .select("type")
    .eq("meeting_id", meetingId)
    .in("status", ["queued", "processing"]);

  const alreadyPending = new Set((existing || []).map((j: { type: string }) => j.type));
  const typesToEnqueue = jobTypes.filter((t) => !alreadyPending.has(t));

  if (typesToEnqueue.length === 0) return [];

  const jobs = typesToEnqueue.map((type) => ({
    meeting_id: meetingId,
    type,
    status: "queued",
    progress: 0,
    retry_count: 0,
    max_retries: 3,
  }));

  const { error } = await supabase.from("ai_jobs").insert(jobs);
  if (error) throw error;

  return typesToEnqueue;
}
