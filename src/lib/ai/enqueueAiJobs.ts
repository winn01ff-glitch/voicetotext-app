import { createServerSupabaseClient } from "@/lib/supabase/server";

// Đưa các job AI vào hàng đợi cho 1 meeting. Model mới chỉ có 2 loại: "process", "summary".
// ai_jobs có UNIQUE(meeting_id, type) → type đã tồn tại thì RESET về queued thay vì insert trùng.
// Không còn run_id fencing / snapshot version (đã bỏ versioning).
//
// mode: tuỳ chọn cho job (vd summary mode: "detailed" | "bullets" | "meeting_minutes"...).
export async function enqueueAiJobs(
  meetingId: string,
  jobTypes: string[],
  mode?: string | null
): Promise<string[]> {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("ai_jobs")
    .select("type, status")
    .eq("meeting_id", meetingId)
    .in("type", jobTypes);

  // Phân loại: đang processing/queued → bỏ qua (tránh 2 worker chạy cùng job),
  // đã tồn tại nhưng idle/completed/failed/cancelled → reset, chưa có → insert.
  const existingMap = new Map(
    (existing || []).map((j: { type: string; status: string }) => [j.type, j.status])
  );
  const inFlightStatuses = new Set(["processing", "queued"]);
  const typesToReset = jobTypes.filter(
    (t) => existingMap.has(t) && !inFlightStatuses.has(existingMap.get(t)!)
  );
  const typesToInsert = jobTypes.filter((t) => !existingMap.has(t));

  if (typesToReset.length > 0) {
    const { error } = await supabase
      .from("ai_jobs")
      .update({
        status: "queued",
        progress: 0,
        retry_count: 0,
        next_retry_at: null,
        error: null,
        ended_at: null,
        mode: mode || null,
      })
      .eq("meeting_id", meetingId)
      .in("type", typesToReset);
    if (error) throw error;
  }

  if (typesToInsert.length > 0) {
    const { error } = await supabase.from("ai_jobs").insert(
      typesToInsert.map((type) => ({
        meeting_id: meetingId,
        type,
        status: "queued",
        progress: 0,
        retry_count: 0,
        max_retries: 3,
        mode: mode || null,
      }))
    );
    if (error) throw error;
  }

  return [...typesToReset, ...typesToInsert];
}
