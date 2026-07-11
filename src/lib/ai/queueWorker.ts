import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  PipelineConfig,
  RawUtterance,
  CorrectedTurn,
  MappedTurn,
  CheckedTurn,
  TranslatedTurn,
  step1_correctSTT,
  step2_speakerMapping,
  step3_consistencyCheck,
  step4_translate,
  step5_summarize,
  step6_extractActions,
  chunkArray
} from "./pipeline";
import { generateEmbeddings } from "./rag";

/**
 * Hàm đọc config của cuộc họp.
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
    .eq("meeting_id", meetingId)
    .eq("is_active", true); // lấy active speakers để làm hint

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
 * Xử lý Auto-Retry với Exponential Backoff.
 * Trả về true nếu job cần retry, false nếu job đã thất bại hoàn toàn.
 */
async function handleJobError(job: any, errorMsg: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const retryCount = (job.retry_count || 0) + 1;
  const maxRetries = job.max_retries || 3;

  if (retryCount <= maxRetries) {
    // Retry with backoff: 5s, 15s, 45s
    const delaySeconds = 5 * Math.pow(3, retryCount - 1);
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    
    await supabase
      .from("ai_jobs")
      .update({
        status: "queued", // Trở lại queued chờ quét tiếp
        progress: 25,
        retry_count: retryCount,
        next_retry_at: nextRetryAt,
        error: `[Retry ${retryCount}/${maxRetries}] ${errorMsg}`
      })
      .eq("id", job.id);
    console.log(`[QueueWorker] Job ${job.id} failed, retrying at ${nextRetryAt}. Error: ${errorMsg}`);
    return true; // Should retry later
  } else {
    await supabase
      .from("ai_jobs")
      .update({
        status: "failed",
        progress: 0,
        error: `[Failed after ${maxRetries} retries] ${errorMsg}`
      })
      .eq("id", job.id);
    console.error(`[QueueWorker] Job ${job.id} permanently failed. Error: ${errorMsg}`);
    return false; // Permanently failed
  }
}

/**
 * Kiểm tra xem job có bị huỷ hay không (Race condition check).
 */
async function checkJobCancelled(jobId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from("ai_jobs").select("status").eq("id", jobId).single();
  return data?.status === "cancelled";
}

/**
 * Worker chạy xử lý hàng đợi. Hàm này không ném lỗi ra ngoài.
 * Nó liên tục lấy các job có status = 'queued' và next_retry_at <= now() để xử lý.
 */
export async function runAIJobsQueue(meetingId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();

  while (true) {
    // 1. Tìm job ưu tiên cao nhất đang chờ.
    // Nếu có job đang queued và đến giờ chạy
    const { data: queuedJobs } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("meeting_id", meetingId)
      .eq("status", "queued")
      .lte("next_retry_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(1);

    // Xử lý các job chưa có next_retry_at (vừa enqueue)
    const { data: newJobs } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("meeting_id", meetingId)
      .eq("status", "queued")
      .is("next_retry_at", null)
      .order("created_at", { ascending: true })
      .limit(1);

    let jobToRun = null;
    if (queuedJobs && queuedJobs.length > 0) {
      jobToRun = queuedJobs[0];
    } else if (newJobs && newJobs.length > 0) {
      jobToRun = newJobs[0];
    }

    if (!jobToRun) {
      // Hết job để chạy
      console.log(`[QueueWorker] No more pending jobs for meeting ${meetingId}.`);
      break;
    }

    // 2. Đánh dấu job đang xử lý
    await supabase.from("ai_jobs").update({ status: "processing", progress: 50, error: null }).eq("id", jobToRun.id);

    try {
      const config = await getMeetingConfig(meetingId);
      
      // 3. Thực thi job theo loại
      if (jobToRun.type === "spellcheck") {
        await executeSpellcheckJob(jobToRun, config);
      } else if (jobToRun.type === "speaker") {
        await executeSpeakerJob(jobToRun, config);
      } else if (jobToRun.type === "translation") {
        await executeTranslationJob(jobToRun, config);
      } else if (jobToRun.type === "summary") {
        await executeSummaryJob(jobToRun, config);
      } else {
        throw new Error("Unknown job type: " + jobToRun.type);
      }

      // 4. Nếu xử lý xong, update thành completed
      if (await checkJobCancelled(jobToRun.id)) {
         throw new Error("CANCELLED");
      }
      await supabase.from("ai_jobs").update({ status: "completed", progress: 100, ended_at: new Date().toISOString() }).eq("id", jobToRun.id);

    } catch (err: any) {
      if (err.message === "CANCELLED") {
        console.log(`[QueueWorker] Job ${jobToRun.id} was cancelled. Aborting queue.`);
        
        // Cập nhật các job đang queued khác của meeting này thành idle
        await supabase.from("ai_jobs").update({ status: "idle", progress: 0 }).eq("meeting_id", meetingId).eq("status", "queued");
        break; // Dừng vòng lặp worker
      }

      // Nếu không phải cancel, xử lý retry
      const isRetrying = await handleJobError(jobToRun, err.message || "Lỗi không xác định");
      if (!isRetrying) {
         // Nếu một job hỏng hoàn toàn, các job sau cũng nên dừng lại hoặc đưa về idle
         await supabase.from("ai_jobs").update({ status: "idle", progress: 0 }).eq("meeting_id", meetingId).eq("status", "queued");
         break;
      }
    }
  }
}

// =========================================================================================
// THỰC THI CHI TIẾT TỪNG JOB
// =========================================================================================

async function getActiveTranscripts(meetingId: string) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("transcripts")
    .select("*")
    .eq("meeting_id", meetingId)
    .eq("is_active", true)
    .order("start_ms", { ascending: true });
  return data || [];
}

async function incrementTranscriptVersion(meetingId: string, newRows: any[], versionType: string) {
  const supabase = await createServerSupabaseClient();
  
  // Find max version
  const { data: maxVerData } = await supabase
    .from("transcripts")
    .select("version")
    .eq("meeting_id", meetingId)
    .order("version", { ascending: false })
    .limit(1)
    .single();
    
  const nextVersion = (maxVerData?.version || 0) + 1;

  if (await checkJobCancelled(newRows[0]?.jobId_for_cancel_check)) return;

  // Look up existing speakers to map speaker_tag → speaker_id
  const { data: speakers } = await supabase
    .from("speakers")
    .select("id, speaker_tag")
    .eq("meeting_id", meetingId);
  const tagToId: Record<string, string> = {};
  (speakers || []).forEach((s: any) => { tagToId[s.speaker_tag] = s.id; });

  // Inactivate old
  await supabase.from("transcripts").update({ is_active: false }).eq("meeting_id", meetingId);

  // Insert new — link speaker_id so the foreign-key join works on the history page
  const insertRows = newRows.map(r => ({
    ...r,
    meeting_id: meetingId,
    version: nextVersion,
    version_type: versionType,
    is_active: true,
    speaker_id: tagToId[r.speaker_tag] || null,
  }));

  const batches = chunkArray(insertRows, 100);
  for (const batch of batches) {
    await supabase.from("transcripts").insert(batch);
  }
  
  return nextVersion;
}

// Job 1: Spellcheck
async function executeSpellcheckJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const activeTranscripts = await getActiveTranscripts(job.meeting_id);
  
  const rawUtterances: RawUtterance[] = activeTranscripts.map(r => ({
    text: r.original_text || "",
    start: (r.start_ms || 0) / 1000,
    end: (r.end_ms || 0) / 1000,
    speaker: parseInt((r.speaker_tag || "speaker_1").replace('speaker_', '')) - 1,
    confidence: r.confidence || 1.0
  }));

  const corrected = await step1_correctSTT(rawUtterances, config, job.mode);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  // step1's prompt guarantees "same order and count — one output per input" (no merge/split
  // at this step), so activeTranscripts[i] safely corresponds to corrected[i]. Carry forward
  // translated_text/confidence — otherwise this version briefly wipes the translation that the
  // live meeting already produced, and the history page (auto-polling every 4s) shows it blank
  // until the translation job runs later in the same auto-enqueued batch.
  const newRows = corrected.map((c, i) => ({
    original_text: c.text, // Sau khi sửa, coi bản sửa là gốc của version này
    corrected_text: c.text,
    translated_text: activeTranscripts[i]?.translated_text ?? null,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    speaker_tag: `speaker_${c.speaker_hint + 1}`,
    speaker_name: `Speaker ${c.speaker_hint + 1}`,
    confidence: activeTranscripts[i]?.confidence ?? null,
  }));

  await incrementTranscriptVersion(job.meeting_id, newRows, 'FINAL');
}

// Job 2: Speaker
async function executeSpeakerJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const activeTranscripts = await getActiveTranscripts(job.meeting_id);

  const correctedTurns: CorrectedTurn[] = activeTranscripts.map(r => ({
    text: r.corrected_text || r.original_text || "",
    start_ms: r.start_ms || 0,
    end_ms: r.end_ms || 0,
    speaker_hint: parseInt((r.speaker_tag || "speaker_1").replace('speaker_', '')) - 1
  }));

  // Diarize
  let mapped: MappedTurn[] = [];
  const batches = chunkArray(correctedTurns, 30); // batch size 30
  for (let i = 0; i < batches.length; i++) {
    if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
    const prevContext = i > 0 ? mapped.slice(-10) : undefined;
    const result = await step2_speakerMapping(batches[i], config, prevContext, job.mode);
    mapped.push(...result);
  }

  // Consistency Check
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const checked = await step3_consistencyCheck(mapped, config);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  // Unlike step1, step2/step3 can split or merge turns (multi-speaker utterances get split,
  // consecutive same-speaker turns get grouped), so turn count isn't guaranteed to match
  // activeTranscripts — there's no safe index to carry translated_text forward from. This
  // version will show blank translations until the translation job runs next in the same
  // auto-enqueued batch (known gap, see executeSpellcheckJob's carry-forward for the step1 case).
  const newRows = checked.map(c => ({
    original_text: c.text,
    corrected_text: c.text,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    speaker_tag: c.speaker_tag,
    speaker_name: c.speaker_name,
    confidence: c.confidence
  }));

  await incrementTranscriptVersion(job.meeting_id, newRows, 'FINAL');
  
  // Generate Embeddings vì transcript đã đạt trạng thái 'FINAL' với Speaker hoàn chỉnh
  if (!(await checkJobCancelled(job.id))) {
     await generateEmbeddings(job.meeting_id);
  }
}

// Job 3: Translation
async function executeTranslationJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const supabase = await createServerSupabaseClient();
  const activeTranscripts = await getActiveTranscripts(job.meeting_id);

  const checkedTurns: CheckedTurn[] = activeTranscripts.map((r: any) => ({
    text: r.corrected_text || r.original_text || "",
    start_ms: r.start_ms || 0,
    end_ms: r.end_ms || 0,
    speaker_tag: r.speaker_tag || "",
    speaker_name: r.speaker_name || "",
    confidence: r.confidence || 1.0
  }));

  const translated = await step4_translate(checkedTurns, config, job.mode);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  const newRows = activeTranscripts.map((r: any, i: number) => {
    // Preserve old data, just add translated_text
    const t = translated[i];
    return {
      original_text: r.original_text,
      corrected_text: r.corrected_text,
      translated_text: t ? t.translated_text : null,
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      speaker_tag: r.speaker_tag,
      speaker_name: r.speaker_name,
      confidence: r.confidence
    };
  });

  await incrementTranscriptVersion(job.meeting_id, newRows, 'FINAL');

  // Translate RAW transcripts for the "Bản gốc" tab
  const { data: rawTranscripts } = await supabase
    .from("transcripts")
    .select("*")
    .eq("meeting_id", job.meeting_id)
    .or("version_type.eq.RAW,version_type.eq.raw")
    .order("start_ms", { ascending: true });

  if (rawTranscripts && rawTranscripts.length > 0) {
    const rawTurns = rawTranscripts.map((r: any) => ({
      text: r.corrected_text || r.original_text || "",
      start_ms: r.start_ms || 0,
      end_ms: r.end_ms || 0,
      speaker_tag: r.speaker_tag || "",
      speaker_name: r.speaker_name || "",
      confidence: r.confidence || 1.0
    }));
    const translatedRaw = await step4_translate(rawTurns, config, job.mode);
    if (!(await checkJobCancelled(job.id))) {
      const updates = rawTranscripts.map((r: any, i: number) => {
        const t = translatedRaw[i];
        return supabase
          .from("transcripts")
          .update({ translated_text: t ? t.translated_text : null })
          .eq("id", r.id);
      });
      await Promise.all(updates);
    }
  }
}

// Job 4: Summary
async function executeSummaryJob(job: any, config: PipelineConfig) {
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  const activeTranscripts = await getActiveTranscripts(job.meeting_id);

  const translatedTurns: TranslatedTurn[] = activeTranscripts.map(r => ({
    original_text: r.corrected_text || r.original_text || "",
    translated_text: r.translated_text || "",
    start_ms: r.start_ms || 0,
    end_ms: r.end_ms || 0,
    speaker_tag: r.speaker_tag || "",
    speaker_name: r.speaker_name || "",
    confidence: r.confidence || 1.0
  }));

  const summary = await step5_summarize(translatedTurns, config, job.mode);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");
  
  const actions = await step6_extractActions(translatedTurns, summary, config);
  if (await checkJobCancelled(job.id)) throw new Error("CANCELLED");

  const supabase = await createServerSupabaseClient();
  
  // Find max version for summary
  const { data: maxSumVer } = await supabase.from("ai_summaries").select("version").eq("meeting_id", job.meeting_id).order("version", { ascending: false }).limit(1).single();
  const nextVer = (maxSumVer?.version || 0) + 1;

  await supabase.from("ai_summaries").update({ is_active: false }).eq("meeting_id", job.meeting_id);
  await supabase.from("ai_summaries").insert({
    meeting_id: job.meeting_id,
    executive_summary: summary.executive_summary,
    decisions: summary.decisions || [],
    version: nextVer,
    is_active: true,
    status: "Completed"
  });

  await supabase.from("action_items").update({ is_active: false }).eq("meeting_id", job.meeting_id);
  if (actions.length > 0) {
    const actionRows = actions.map(a => ({
      meeting_id: job.meeting_id,
      description: a.description,
      owner: a.owner,
      deadline: a.deadline,
      version: nextVer,
      is_active: true
    }));
    await supabase.from("action_items").insert(actionRows);
  }
}
