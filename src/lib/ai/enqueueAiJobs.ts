import { createServerSupabaseClient } from "@/lib/supabase/server";

// Shared helper for both the manual "Phân tích toàn diện" trigger and the
// automatic post-meeting enqueue. Skips any job type that already has a
// queued/processing row for this meeting, so the two triggers can't stack
// duplicate/overlapping runs against the same transcript version.
//
// ai_jobs has UNIQUE(meeting_id, type), so a job type that already ran
// (completed/failed/cancelled/idle) can't be re-inserted — those rows are
// RESET back to queued instead. Only genuinely new types get an insert.
//
// mode: optional processing mode for the job (e.g. "detailed", "bullets",
//       "meeting_minutes", "translate_clean", "professional", etc.)
export async function enqueueAiJobs(meetingId: string, jobTypes: string[], mode?: string | null): Promise<string[]> {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("ai_jobs")
    .select("type, status")
    .eq("meeting_id", meetingId)
    .in("type", jobTypes);

  const existingByType = new Map((existing || []).map((j: { type: string; status: string }) => [j.type, j.status]));

  const typesToReset: string[] = [];
  const typesToInsert: string[] = [];
  for (const type of jobTypes) {
    const status = existingByType.get(type);
    if (status) typesToReset.push(type);
    else typesToInsert.push(type);
  }

  if (typesToReset.length > 0) {
    const { error } = await supabase
      .from("ai_jobs")
      .update({ status: "queued", progress: 0, retry_count: 0, next_retry_at: null, error: null, ended_at: null, mode: mode || null })
      .eq("meeting_id", meetingId)
      .in("type", typesToReset);
    if (error) throw error;
  }

  if (typesToInsert.length > 0) {
    const jobs = typesToInsert.map((type) => ({
      meeting_id: meetingId,
      type,
      status: "queued",
      progress: 0,
      retry_count: 0,
      max_retries: 3,
      mode: mode || null,
    }));
    const { error } = await supabase.from("ai_jobs").insert(jobs);
    if (error) throw error;
  }

  return [...typesToReset, ...typesToInsert];
}
