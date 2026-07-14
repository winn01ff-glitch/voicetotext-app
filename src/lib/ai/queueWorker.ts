import { createHash } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  PipelineConfig,
  TranslatedTurn,
  step5_summarize,
  step6_extractActions,
} from "./pipeline";
import { processMeetingTranscript } from "./processPipeline";
import { generateEmbeddings } from "./rag";

function hashText(t: string): string {
  return createHash("sha256").update((t || "").trim()).digest("hex");
}

/**
 * Đọc config của cuộc họp (title, ngôn ngữ, ngữ cảnh, glossary, speakers).
 */
async function getMeetingConfig(meetingId: string): Promise<PipelineConfig> {
  const supabase = await createServerSupabaseClient();
  const { data: meeting } = await supabase
    .from("meetings")
    .select("title, source_language, target_language, meeting_context")
    .eq("id", meetingId)
    .single();

  const { data: glossary } = await supabase
    .from("glossary")
    .select("*")
    .eq("meeting_id", meetingId);

  const { data: speakers } = await supabase
    .from("speakers")
    .select("*")
    .eq("meeting_id", meetingId);

  return {
    title: meeting?.title || "Meeting",
    meetingContext: meeting?.meeting_context || "",
    sourceLanguage: meeting?.source_language || "auto",
    targetLanguage: meeting?.target_language || "vi",
    glossary: glossary || [],
    speakers: speakers || [],
  };
}

/**
 * Auto-retry với exponential backoff. Trả về true nếu job sẽ retry, false nếu hỏng hẳn.
 */
async function handleJobError(job: any, errorMsg: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const retryCount = (job.retry_count || 0) + 1;
  const maxRetries = job.max_retries || 3;

  if (retryCount <= maxRetries) {
    const delaySeconds = 5 * Math.pow(3, retryCount - 1); // 5s, 15s, 45s
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await supabase
      .from("ai_jobs")
      .update({
        status: "queued",
        progress: 25,
        retry_count: retryCount,
        next_retry_at: nextRetryAt,
        error: `[Retry ${retryCount}/${maxRetries}] ${errorMsg}`,
      })
      .eq("id", job.id);
    console.log(`[QueueWorker] Job ${job.id} failed, retrying at ${nextRetryAt}. Error: ${errorMsg}`);
    return true;
  }

  await supabase
    .from("ai_jobs")
    .update({ status: "failed", progress: 0, error: `[Failed after ${maxRetries} retries] ${errorMsg}` })
    .eq("id", job.id);
  console.error(`[QueueWorker] Job ${job.id} permanently failed. Error: ${errorMsg}`);
  return false;
}

/** Kiểm tra job có bị huỷ hay không. */
async function checkJobCancelled(jobId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from("ai_jobs").select("status").eq("id", jobId).single();
  return data?.status === "cancelled";
}

/**
 * Worker chạy hàng đợi AI cho 1 meeting. Không ném lỗi ra ngoài.
 * Model mới: chỉ 2 loại job — "process" (cắt dòng + phân vai + sửa + dịch) rồi "summary".
 * Không còn versioning / run_id fencing.
 */
export async function runAIJobsQueue(meetingId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  while (true) {
    // 1. Lấy 1 job queued đã tới hạn retry (hoặc chưa từng retry).
    const { data: dueJobs } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("meeting_id", meetingId)
      .eq("status", "queued")
      .lte("next_retry_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(1);

    const { data: newJobs } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("meeting_id", meetingId)
      .eq("status", "queued")
      .is("next_retry_at", null)
      .order("created_at", { ascending: true })
      .limit(1);

    const jobToRun = (dueJobs && dueJobs[0]) || (newJobs && newJobs[0]) || null;
    if (!jobToRun) {
      console.log(`[QueueWorker] No more pending jobs for meeting ${meetingId}.`);
      // Hàng đợi cạn bình thường → đánh dấu cuộc họp hoàn tất.
      await supabase
        .from("meetings")
        .update({ status: "completed", progress: { percent: 100, message: "Hoàn thành!" } })
        .eq("id", meetingId)
        .neq("status", "cancelled");
      break;
    }

    // 2. Claim có điều kiện: chỉ set processing nếu vẫn còn queued (tránh hồi sinh job vừa bị huỷ).
    const { data: claimed } = await supabase
      .from("ai_jobs")
      .update({ status: "processing", progress: 50, error: null, started_at: new Date().toISOString() })
      .eq("id", jobToRun.id)
      .eq("status", "queued")
      .select("id");

    if (!claimed || claimed.length === 0) continue;

    try {
      const config = await getMeetingConfig(meetingId);

      if (jobToRun.type === "process") {
        await executeProcessJob(jobToRun, config);
      } else if (jobToRun.type === "summary") {
        await executeSummaryJob(jobToRun, config);
      } else {
        throw new Error("Unknown job type: " + jobToRun.type);
      }

      if (await checkJobCancelled(jobToRun.id)) throw new Error("CANCELLED");
      await supabase
        .from("ai_jobs")
        .update({ status: "completed", progress: 100, ended_at: new Date().toISOString() })
        .eq("id", jobToRun.id);
    } catch (err: any) {
      if (err.message === "CANCELLED") {
        console.log(`[QueueWorker] Job ${jobToRun.id} cancelled. Worker stopping.`);
        break;
      }
      const isRetrying = await handleJobError(jobToRun, err.message || "Lỗi không xác định");
      if (!isRetrying) {
        // Job hỏng hẳn → đưa các job queued còn lại về idle rồi dừng.
        await supabase
          .from("ai_jobs")
          .update({ status: "idle", progress: 0 })
          .eq("meeting_id", meetingId)
          .eq("status", "queued");
        break;
      }
    }
  }
}

// =========================================================================================
// JOB: process — cắt dòng + phân vai + sửa chính tả + dịch (1 lượt hợp nhất)
// =========================================================================================

async function executeProcessJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  await processMeetingTranscript(job.meeting_id, config, () => checkJobCancelled(job.id), job.mode);

  // Transcript đã ở trạng thái xử lý xong → tạo embeddings cho RAG (Ask AI).
  if (!(await checkJobCancelled(job.id))) {
    await generateEmbeddings(job.meeting_id);
  }
}

// =========================================================================================
// JOB: summary — tóm tắt + action items (ghi đè bản duy nhất)
// =========================================================================================

async function getProcessedTranscripts(meetingId: string) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("transcripts")
    .select("*")
    .eq("meeting_id", meetingId)
    .order("start_ms", { ascending: true });
  return data || [];
}

async function executeSummaryJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const supabase = await createServerSupabaseClient();

  const transcripts = await getProcessedTranscripts(job.meeting_id);
  const translatedTurns: TranslatedTurn[] = transcripts.map((r: any) => ({
    original_text: r.original_text || "",
    translated_text: r.translated_text || "",
    start_ms: r.start_ms || 0,
    end_ms: r.end_ms || 0,
    speaker_tag: r.speaker_tag || "",
    speaker_name: r.speaker_name || "",
    confidence: r.confidence || 1.0,
  }));

  // Dirty-check: tóm tắt phụ thuộc nội dung (bản dịch/gốc) + mode, không phụ thuộc nhãn người nói.
  const contentForHash = translatedTurns
    .map((t) => (t.translated_text || t.original_text || "").trim())
    .join("\n");
  const summaryHash = hashText(`${job.mode || ""}::${contentForHash}`);

  const { data: current } = await supabase
    .from("ai_summaries")
    .select("id, source_hash")
    .eq("meeting_id", job.meeting_id)
    .maybeSingle();

  if (current?.source_hash && current.source_hash === summaryHash) {
    await supabase.from("ai_summaries").update({ status: "Completed" }).eq("id", current.id);
    return;
  }

  const summary = await step5_summarize(translatedTurns, config, job.mode);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  const actions = await step6_extractActions(translatedTurns, summary, config);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  // Ghi đè bản tóm tắt duy nhất của meeting (không versioning).
  await supabase.from("ai_summaries").delete().eq("meeting_id", job.meeting_id);
  await supabase.from("ai_summaries").insert({
    meeting_id: job.meeting_id,
    executive_summary: summary.executive_summary,
    decisions: summary.decisions || [],
    status: "Completed",
    source_hash: summaryHash,
  });

  await supabase.from("action_items").delete().eq("meeting_id", job.meeting_id);
  if (actions.length > 0) {
    await supabase.from("action_items").insert(
      actions.map((a) => ({
        meeting_id: job.meeting_id,
        description: a.description,
        owner: a.owner,
        deadline: a.deadline,
      }))
    );
  }
}
