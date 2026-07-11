// ================================================================
// Pipeline AI xử lý transcript cho Upload / YouTube
// 6 bước: correctSTT → speakerMapping → consistencyCheck → translate → summarize → extractActions
// Chunking: audio > 10 phút chia thành chunks. Bước 1-2 per chunk, merge, rồi 3-6 trên toàn bộ.
// ================================================================

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DeepgramClient } from "@deepgram/sdk";

// ================================================================
// Types & Interfaces
// ================================================================

/** Cấu hình pipeline truyền từ caller */
export interface PipelineConfig {
  title: string;
  meetingContext: string;
  sourceLanguage: string; // 'auto' | 'vi' | 'en' | 'ja'
  targetLanguage: string; // 'vi' | 'en' | 'ja'
  speakers: PipelineSpeaker[];
  glossary: GlossaryEntry[];
}

export interface PipelineSpeaker {
  speaker_tag: string;
  display_name: string;
  language_code?: string;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  source_language?: string;
  target_language?: string;
}

/** Utterance thô từ Deepgram */
export interface RawUtterance {
  text: string;
  start: number; // giây (float)
  end: number;   // giây (float)
  speaker: number; // Deepgram speaker index (0, 1, 2...)
  confidence?: number;
}

/** Turn sau bước 1 (correctSTT) */
export interface CorrectedTurn {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_hint: number; // Deepgram speaker index gốc
}

/** Turn sau bước 2 (speakerMapping) */
export interface MappedTurn {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_tag: string;    // "speaker_1", "speaker_2"...
  speaker_name: string;
  confidence: number;
}

/** Turn sau bước 3 (consistencyCheck) */
export interface CheckedTurn {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_tag: string;
  speaker_name: string;
  confidence: number;
}

/** Turn sau bước 4 (translate) */
export interface TranslatedTurn {
  original_text: string;
  translated_text: string;
  start_ms: number;
  end_ms: number;
  speaker_tag: string;
  speaker_name: string;
  confidence: number;
}

/** Kết quả summary từ bước 5 */
export interface SummaryResult {
  executive_summary: string;
  decisions: string[];
}

/** Action item từ bước 6 */
export interface ActionItem {
  description: string;
  owner: string | null;
  deadline: string | null;
}

/** Kết quả Deepgram đã lưu cho mỗi chunk */
export interface DeepgramChunkResult {
  chunk_index: number;
  offset_ms: number;
  deepgram_response: any;
}

/** Progress JSONB lưu trong meetings.progress */
export interface PipelineProgress {
  percent: number;
  chunk_current?: number;
  chunk_total?: number;
  message: string;
}

/** Checkpoint để resume pipeline */
export type PipelineStep =
  | "uploading"
  | "transcribing"
  | "correcting"
  | "diarizing"
  | "checking"
  | "translating"
  | "summarizing"
  | "extracting"
  | "saving";

// ================================================================
// Constants
// ================================================================

const AI_FAST_MODEL = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
const AI_QUALITY_MODEL = process.env.AI_QUALITY_MODEL || "gemini-2.5-pro";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";

/** Số utterance tối đa mỗi batch gửi Gemini (tránh quá dài) */
const BATCH_SIZE = 20;

/** Retry config */
const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s → 4s → 8s exponential backoff

/** Status ↔ % progress mapping */
const STATUS_PERCENT: Record<PipelineStep, number> = {
  uploading: 2,
  transcribing: 10,
  correcting: 25,
  diarizing: 40,
  checking: 55,
  translating: 70,
  summarizing: 85,
  extracting: 92,
  saving: 98,
};

/** Label tiếng Việt cho mỗi bước */
const STATUS_LABEL: Record<PipelineStep, string> = {
  uploading: "Đang tải lên...",
  transcribing: "Đang phiên âm với Deepgram...",
  correcting: "Đang sửa lỗi STT...",
  diarizing: "Đang phân tách người nói...",
  checking: "Đang kiểm tra tính nhất quán...",
  translating: "Đang dịch...",
  summarizing: "Đang tạo tóm tắt...",
  extracting: "Đang trích xuất công việc...",
  saving: "Đang lưu kết quả...",
};

// ================================================================
// Gemini Helper — tạo client, gọi model với fallback
// ================================================================

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not configured");
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Gọi Gemini với model chỉ định, tự fallback sang gemini-3.1-flash-lite nếu lỗi.
 * Trả về parsed JSON object.
 */
async function callGemini<T = any>(
  prompt: string,
  modelName: string
): Promise<T> {
  const genAI = getGeminiClient();

  let result;
  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json" },
    });
    result = await model.generateContent(prompt);
  } catch (err) {
    console.warn(`Model ${modelName} failed, falling back to ${FALLBACK_MODEL}:`, err);
    const fallbackModel = genAI.getGenerativeModel({
      model: FALLBACK_MODEL,
      generationConfig: { responseMimeType: "application/json" },
    });
    result = await fallbackModel.generateContent(prompt);
  }

  let responseText = result.response.text().trim();

  // Robustly extract JSON — loại bỏ markdown wrappers nếu có
  const startIdx = responseText.indexOf("{");
  const endIdx = responseText.lastIndexOf("}");
  // Cũng kiểm tra array response
  const arrStartIdx = responseText.indexOf("[");
  const arrEndIdx = responseText.lastIndexOf("]");

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Nếu array bắt đầu trước object, ưu tiên array
    if (arrStartIdx !== -1 && arrStartIdx < startIdx) {
      responseText = responseText.substring(arrStartIdx, arrEndIdx + 1);
    } else {
      responseText = responseText.substring(startIdx, endIdx + 1);
    }
  } else if (arrStartIdx !== -1 && arrEndIdx !== -1 && arrEndIdx > arrStartIdx) {
    responseText = responseText.substring(arrStartIdx, arrEndIdx + 1);
  }

  return JSON.parse(responseText) as T;
}

/**
 * Chia array thành batches nhỏ hơn
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// ================================================================
// 1. updateProgress — cập nhật meetings.status + meetings.progress
// ================================================================

export async function updateProgress(
  meetingId: string,
  status: PipelineStep | "completed" | "failed" | "cancelled",
  chunkCurrent?: number,
  chunkTotal?: number,
  customMessage?: string
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  const percent = status in STATUS_PERCENT
    ? STATUS_PERCENT[status as PipelineStep]
    : status === "completed" ? 100 : 0;

  const defaultMessage = status in STATUS_LABEL
    ? STATUS_LABEL[status as PipelineStep]
    : status === "completed" ? "Hoàn thành!" : "Đã xảy ra lỗi.";

  const message = customMessage || defaultMessage;

  const progress: PipelineProgress = {
    percent,
    message,
    ...(chunkCurrent !== undefined && { chunk_current: chunkCurrent }),
    ...(chunkTotal !== undefined && { chunk_total: chunkTotal }),
  };

  const { error } = await supabase
    .from("meetings")
    .update({ status, progress })
    .eq("id", meetingId);

  if (error) {
    console.error(`[Pipeline] updateProgress failed for ${meetingId}:`, error);
  }
}

// ================================================================
// 2. checkCancelled — kiểm tra nếu user đã cancel
// ================================================================

export async function checkCancelled(meetingId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("meetings")
    .select("status")
    .eq("id", meetingId)
    .single();

  if (error) {
    console.error(`[Pipeline] checkCancelled failed for ${meetingId}:`, error);
    return; // Không throw — tiếp tục pipeline
  }

  if (data?.status === "cancelled") {
    throw new Error("CANCELLED");
  }
}

// ================================================================
// 3. withRetry — retry 3x với exponential backoff, ghi pipeline_errors khi fail
// ================================================================

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  chunkIndex?: number;
  inputSnapshot?: any;
}

export async function withRetry<T>(
  meetingId: string,
  step: string,
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelayMs ?? BASE_DELAY_MS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Nếu bị cancel thì throw ngay, không retry
      if (err?.message === "CANCELLED") throw err;

      console.warn(
        `[Pipeline] ${step} attempt ${attempt}/${maxRetries} failed:`,
        err?.message || err
      );

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // 2s, 4s, 8s
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Sau khi retry hết → ghi vào pipeline_errors (Dead Letter Queue)
  try {
    const supabase = await createServerSupabaseClient();
    await supabase.from("pipeline_errors").insert({
      meeting_id: meetingId,
      step,
      chunk_index: options?.chunkIndex ?? null,
      attempt_count: maxRetries,
      error_message: lastError?.message || String(lastError),
      error_stack: lastError?.stack || null,
      input_snapshot: options?.inputSnapshot
        ? JSON.parse(JSON.stringify(options.inputSnapshot)).toString !== undefined
          ? options.inputSnapshot
          : null
        : null,
      resolved: false,
    });
  } catch (dbErr) {
    console.error(`[Pipeline] Failed to insert pipeline_error for ${step}:`, dbErr);
  }

  throw lastError!;
}

// ================================================================
// 4. savePipelineStep — JSONB merge vào meetings.pipeline_results
// ================================================================

export async function savePipelineStep(
  meetingId: string,
  key: string,
  data: any
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Đọc pipeline_results hiện tại
  const { data: meeting, error: fetchError } = await supabase
    .from("meetings")
    .select("pipeline_results")
    .eq("id", meetingId)
    .single();

  if (fetchError) {
    console.error(`[Pipeline] savePipelineStep fetch failed:`, fetchError);
  }

  const current = (meeting?.pipeline_results as Record<string, any>) || {};
  current[key] = data;

  const { error: updateError } = await supabase
    .from("meetings")
    .update({ pipeline_results: current })
    .eq("id", meetingId);

  if (updateError) {
    console.error(`[Pipeline] savePipelineStep update failed for key=${key}:`, updateError);
  }
}

// ================================================================
// STEP 1: correctSTT — Gemini sửa lỗi STT
// ================================================================

export async function step1_correctSTT(
  utterances: RawUtterance[],
  config: PipelineConfig
): Promise<CorrectedTurn[]> {
  if (utterances.length === 0) return [];

  const batches = chunkArray(utterances, BATCH_SIZE);
  const allCorrected: CorrectedTurn[] = [];

  for (const batch of batches) {
    const inputData = batch.map((u, i) => ({
      index: i + 1,
      text: u.text,
      speaker: u.speaker,
      start: u.start,
      end: u.end,
    }));

    const glossaryStr = config.glossary.length > 0
      ? JSON.stringify(config.glossary.map((g) => ({ source: g.source, target: g.target })))
      : "(không có)";

    const sourceLangLabel = getSourceLangLabel(config.sourceLanguage);

    const prompt = `
Bạn là chuyên gia chỉnh sửa văn bản phiên âm (STT post-correction).

==================================================
THÔNG TIN CUỘC HỌP
==================================================
Tiêu đề: ${config.title}
Ngôn ngữ gốc: ${sourceLangLabel}
Ngữ cảnh: ${config.meetingContext || "General discussion"}

BẢNG THUẬT NGỮ (Glossary):
${glossaryStr}

==================================================
DỮ LIỆU ĐẦU VÀO (Raw STT output)
==================================================
${JSON.stringify(inputData)}

==================================================
HƯỚNG DẪN
==================================================
1. Sửa lỗi phiên âm rõ ràng:
   - Sai chính tả do ASR (ví dụ: kanji sai, thiếu dấu tiếng Việt, homophones tiếng Anh)
   - Áp dụng glossary nếu có từ khớp
   - KHÔNG thêm/bớt/diễn giải lại nội dung
   - Giữ nguyên filler words (えー, あの, umm, à, ờ, uh)
   - Giữ nguyên backchannel (はい, vâng, yeah, okay)

2. Giữ NGUYÊN trật tự và số lượng utterances — mỗi input tạo đúng 1 output.

3. KHÔNG gộp hoặc tách câu ở bước này.

==================================================
OUTPUT FORMAT — Trả về JSON ONLY, không markdown
==================================================
{
  "corrected_turns": [
    {
      "text": "văn bản đã sửa",
      "start_ms": 12340,
      "end_ms": 15670,
      "speaker_hint": 0
    }
  ]
}

Chú ý: start_ms và end_ms tính bằng milliseconds (nhân start/end với 1000).
speaker_hint giữ nguyên giá trị speaker từ input.
`;

    // No live-latency pressure here — use the quality tier so this background/full-context
    // pass is actually better than the live batch pass, not just "the same model run twice".
    const result = await callGemini<{ corrected_turns: CorrectedTurn[] }>(prompt, AI_QUALITY_MODEL);
    const turns = result.corrected_turns || [];

    // Fallback: nếu Gemini trả về ít hơn input, pad bằng input gốc
    for (let i = 0; i < batch.length; i++) {
      if (turns[i]) {
        allCorrected.push(turns[i]);
      } else {
        allCorrected.push({
          text: batch[i].text,
          start_ms: Math.round(batch[i].start * 1000),
          end_ms: Math.round(batch[i].end * 1000),
          speaker_hint: batch[i].speaker,
        });
      }
    }
  }

  return allCorrected;
}

// ================================================================
// STEP 2: speakerMapping — Gemini phân tách người nói với confidence
// ================================================================

export async function step2_speakerMapping(
  correctedTurns: CorrectedTurn[],
  config: PipelineConfig,
  prevContext?: MappedTurn[]
): Promise<MappedTurn[]> {
  if (correctedTurns.length === 0) return [];

  const batches = chunkArray(correctedTurns, BATCH_SIZE);
  const allMapped: MappedTurn[] = [];

  for (const batch of batches) {
    const inputData = batch.map((t, i) => ({
      index: i + 1,
      text: t.text,
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      speaker_hint: t.speaker_hint,
    }));

    const speakersStr = config.speakers.length > 0
      ? JSON.stringify(config.speakers)
      : "[{\"speaker_tag\": \"speaker_1\", \"display_name\": \"Speaker 1\"}]";

    const prevContextStr = prevContext && prevContext.length > 0
      ? JSON.stringify(prevContext.slice(-10)) // Chỉ gửi 10 turns cuối làm context
      : "(không có — đây là chunk đầu tiên)";

    const sourceLangInstruction = getSourceLangInstruction(config.sourceLanguage);

    const prompt = `
Bạn là chuyên gia diarization (phân tách người nói) cho cuộc họp.

==================================================
THÔNG TIN CUỘC HỌP
==================================================
Tiêu đề: ${config.title}
Ngữ cảnh: ${config.meetingContext || "General discussion"}
${sourceLangInstruction}

DANH SÁCH NGƯỜI NÓI ĐÃ ĐĂNG KÝ:
${speakersStr}

CONTEXT TỪ CHUNK TRƯỚC (10 turns cuối):
${prevContextStr}

==================================================
DỮ LIỆU ĐẦU VÀO (đã sửa lỗi STT)
==================================================
${JSON.stringify(inputData)}

==================================================
HƯỚNG DẪN
==================================================
1. SPEAKER ASSIGNMENT:
   - "speaker_hint" là gợi ý từ Deepgram audio analysis (0-indexed).
   - Map speaker_hint thành speaker_tag: hint 0 → "speaker_1", hint 1 → "speaker_2", v.v.
   - VERIFY bằng nội dung: đại từ, register, ngữ cảnh hội thoại.
   - Nếu hint đúng → giữ. Nếu sai logic → sửa lại.
   - Nếu 1 utterance chứa nhiều người nói → TÁCH thành nhiều turns.

2. CONFIDENCE SCORING (0.0 → 1.0):
   - 0.9–1.0: Rõ ràng (xưng hô, tên riêng, context khớp)
   - 0.7–0.89: Khá chắc (register khớp, logic hội thoại đúng)
   - < 0.7: Không chắc chắn → speaker_name = "Unknown Speaker"

3. BACKCHANNEL DETECTION:
   - Phản hồi ngắn (はい, vâng, yeah, uh-huh) thuộc về LISTENER, không phải speaker đang nói.
   - Tách ra và gán cho người nghe.

4. CONSECUTIVE GROUPING: Gộp các turns liên tiếp cùng speaker.

==================================================
OUTPUT FORMAT — JSON ONLY
==================================================
{
  "mapped_turns": [
    {
      "text": "nội dung",
      "start_ms": 12340,
      "end_ms": 15670,
      "speaker_tag": "speaker_1",
      "speaker_name": "Tên người nói",
      "confidence": 0.92
    }
  ]
}

RULES:
- speaker_name lấy từ DANH SÁCH NGƯỜI NÓI nếu match. Nếu confidence < 0.7, dùng "Unknown Speaker".
- Nếu phát hiện speaker mới (không có trong danh sách), gán tag tuần tự (speaker_3, speaker_4...) và name = "Speaker X".
- Giữ nguyên thứ tự thời gian.
- Không hallucinate nội dung.
`;

    const result = await callGemini<{ mapped_turns: MappedTurn[] }>(prompt, AI_QUALITY_MODEL);
    const turns = result.mapped_turns || [];

    // Đảm bảo confidence < 0.7 → Unknown Speaker
    for (const turn of turns) {
      if (turn.confidence < 0.7) {
        turn.speaker_name = "Unknown Speaker";
      }
      allMapped.push(turn);
    }
  }

  return allMapped;
}

// ================================================================
// STEP 3: consistencyCheck — Gemini QA toàn bộ transcript
// ================================================================

export async function step3_consistencyCheck(
  mergedTurns: MappedTurn[],
  config: PipelineConfig
): Promise<CheckedTurn[]> {
  if (mergedTurns.length === 0) return [];

  // Bước 3 chạy trên toàn bộ transcript, nhưng vẫn cần batching nếu quá dài
  const batches = chunkArray(mergedTurns, BATCH_SIZE * 2); // 40 turns per batch cho consistency check
  const allChecked: CheckedTurn[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const inputData = batch.map((t, i) => ({
      index: i + 1,
      text: t.text,
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      speaker_tag: t.speaker_tag,
      speaker_name: t.speaker_name,
      confidence: t.confidence,
    }));

    // Context từ batch trước (nếu có)
    const prevBatchContext = batchIdx > 0
      ? JSON.stringify(allChecked.slice(-5))
      : "(batch đầu tiên)";

    const prompt = `
Bạn là chuyên gia QA (Quality Assurance) cho biên bản cuộc họp.

==================================================
THÔNG TIN CUỘC HỌP
==================================================
Tiêu đề: ${config.title}
Ngữ cảnh: ${config.meetingContext || "General discussion"}
Ngôn ngữ gốc: ${getSourceLangLabel(config.sourceLanguage)}
Tổng số turns toàn transcript: ${mergedTurns.length}
Batch hiện tại: ${batchIdx + 1}/${batches.length}

DANH SÁCH NGƯỜI NÓI:
${JSON.stringify(config.speakers)}

BẢNG THUẬT NGỮ:
${JSON.stringify(config.glossary.map((g) => ({ source: g.source, target: g.target })))}

CONTEXT TỪ BATCH TRƯỚC:
${prevBatchContext}

==================================================
DỮ LIỆU CẦN KIỂM TRA
==================================================
${JSON.stringify(inputData)}

==================================================
NHIỆM VỤ KIỂM TRA
==================================================
1. THỐNG NHẤT TÊN RIÊNG:
   - Đảm bảo cùng một người/tổ chức/sản phẩm dùng cùng cách viết xuyên suốt.
   - Ví dụ: "Tanaka" vs "Tanaka-san" → thống nhất theo pattern chung.

2. SỬA LỖI CÒN SÓT:
   - Lỗi chính tả, ngữ pháp, ASR artifacts mà bước trước chưa bắt.
   - KHÔNG thêm/bớt nội dung.

3. MERGE TURNS BẤT HỢP LÝ:
   - Nếu 2 turns liên tiếp cùng speaker và khoảng cách < 2 giây → gộp thành 1.
   - start_ms = min, end_ms = max, text = nối.

4. SPLIT TURNS CÓ VẤN ĐỀ:
   - Nếu 1 turn rõ ràng chứa 2 người nói khác nhau → tách ra.

5. VALIDATE DATA:
   - Kiểm tra không mất dữ liệu (số turns output ≈ input, cho phép ±20% do merge/split).
   - Kiểm tra JSON hợp lệ.
   - Kiểm tra thứ tự thời gian (start_ms tăng dần).

==================================================
OUTPUT FORMAT — JSON ONLY
==================================================
{
  "checked_turns": [
    {
      "text": "nội dung đã kiểm tra",
      "start_ms": 12340,
      "end_ms": 15670,
      "speaker_tag": "speaker_1",
      "speaker_name": "Tên người nói",
      "confidence": 0.92
    }
  ]
}
`;

    const result = await callGemini<{ checked_turns: CheckedTurn[] }>(prompt, AI_QUALITY_MODEL);
    const turns = result.checked_turns || [];
    allChecked.push(...turns);
  }

  return allChecked;
}

// ================================================================
// STEP 4: translate — Gemini dịch sang ngôn ngữ đích
// ================================================================

export async function step4_translate(
  checkedTurns: CheckedTurn[],
  config: PipelineConfig
): Promise<TranslatedTurn[]> {
  if (checkedTurns.length === 0) return [];

  const batches = chunkArray(checkedTurns, BATCH_SIZE);
  const allTranslated: TranslatedTurn[] = [];

  for (const batch of batches) {
    const inputData = batch.map((t, i) => ({
      index: i + 1,
      text: t.text,
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      speaker_tag: t.speaker_tag,
      speaker_name: t.speaker_name,
    }));

    const glossaryStr = config.glossary.length > 0
      ? JSON.stringify(config.glossary.map((g) => ({
          source: g.source,
          target: g.target,
          source_lang: g.source_language,
          target_lang: g.target_language,
        })))
      : "(không có)";

    const prompt = `
Bạn là phiên dịch viên chuyên nghiệp cho cuộc họp đa ngôn ngữ.

==================================================
CẤU HÌNH DỊCH
==================================================
Ngôn ngữ gốc: ${getSourceLangLabel(config.sourceLanguage)}
Ngôn ngữ đích: ${config.targetLanguage}
Tiêu đề cuộc họp: ${config.title}

BẢNG THUẬT NGỮ (ưu tiên dùng bản dịch này khi gặp từ khớp):
${glossaryStr}

==================================================
DỮ LIỆU CẦN DỊCH
==================================================
${JSON.stringify(inputData)}

==================================================
HƯỚNG DẪN DỊCH
==================================================
1. Dịch MỖI turn sang "${config.targetLanguage}" một cách tự nhiên, trung thành với nguyên văn.
2. Nếu text gốc ĐÃ là "${config.targetLanguage}" → translated_text = text gốc (copy nguyên).
3. KHÔNG dịch tên riêng người, địa danh — giữ nguyên.
4. Áp dụng glossary nếu có từ khớp.
5. Giữ nguyên register/tone (formal ↔ formal, casual ↔ casual).
6. Filler words có thể lược bỏ hoặc giữ tùy ngữ cảnh tự nhiên.

==================================================
OUTPUT FORMAT — JSON ONLY
==================================================
{
  "translated_turns": [
    {
      "original_text": "text gốc",
      "translated_text": "bản dịch",
      "start_ms": 12340,
      "end_ms": 15670,
      "speaker_tag": "speaker_1",
      "speaker_name": "Tên",
      "confidence": 0.92
    }
  ]
}
`;

    const result = await callGemini<{ translated_turns: TranslatedTurn[] }>(prompt, AI_FAST_MODEL);
    const turns = result.translated_turns || [];

    // Fallback: nếu thiếu, pad bằng input gốc
    for (let i = 0; i < batch.length; i++) {
      if (turns[i]) {
        allTranslated.push(turns[i]);
      } else {
        allTranslated.push({
          original_text: batch[i].text,
          translated_text: batch[i].text, // Không dịch được → giữ nguyên
          start_ms: batch[i].start_ms,
          end_ms: batch[i].end_ms,
          speaker_tag: batch[i].speaker_tag,
          speaker_name: batch[i].speaker_name,
          confidence: batch[i].confidence,
        });
      }
    }
  }

  return allTranslated;
}

// ================================================================
// STEP 5: summarize — Gemini tóm tắt + decisions (AI_QUALITY_MODEL)
// ================================================================

export async function step5_summarize(
  translatedTurns: TranslatedTurn[],
  config: PipelineConfig
): Promise<SummaryResult> {
  if (translatedTurns.length === 0) {
    return {
      executive_summary: "(Không có nội dung đối thoại nào được ghi nhận)",
      decisions: [],
    };
  }

  // Format transcript log giống pattern từ regenerate-summary
  const transcriptLog = translatedTurns
    .map((t) => {
      const timeMin = Math.floor(t.start_ms / 60000);
      const timeSec = Math.floor((t.start_ms % 60000) / 1000);
      const timeStr = `${String(timeMin).padStart(2, "0")}:${String(timeSec).padStart(2, "0")}`;
      return `[${timeStr}] ${t.speaker_name}: ${t.original_text} (Dịch: ${t.translated_text || "N/A"})`;
    })
    .join("\n");

  const prompt = `
Bạn là một thư ký cuộc họp chuyên nghiệp sử dụng mô hình trí tuệ nhân tạo chất lượng cao.
Nhiệm vụ của bạn là đọc toàn bộ biên bản cuộc họp sau đây và trả về một báo cáo tóm tắt chất lượng cao dưới dạng JSON:
1. Executive Summary (Tóm tắt tổng quan): Một đoạn văn ngắn gọn mô tả mục đích và kết quả chung của cuộc họp.
2. Key Decisions (Quyết định cốt lõi): Danh sách các quyết định hoặc thỏa thuận quan trọng đã được thông qua.

Thông tin cuộc họp:
- Tiêu đề: ${config.title}
- Ngữ cảnh: ${config.meetingContext || "General discussion"}
- Ngôn ngữ gốc: ${getSourceLangLabel(config.sourceLanguage)}
- Ngôn ngữ dịch: ${config.targetLanguage}

Biên bản cuộc họp cần phân tích:
---
${transcriptLog}
---

Hãy trả về một đối tượng JSON khớp chính xác với cấu trúc sau:
{
  "executive_summary": "nội dung tóm tắt tổng quan cuộc họp...",
  "decisions": [
    "Quyết định thứ nhất...",
    "Quyết định thứ hai..."
  ]
}

IMPORTANT:
- Viết tóm tắt bằng ngôn ngữ "${config.targetLanguage}".
- Nếu không có quyết định rõ ràng, trả mảng rỗng.
- Không hallucinate thông tin không có trong biên bản.
`;

  // Dùng AI_QUALITY_MODEL cho bước summary
  return await callGemini<SummaryResult>(prompt, AI_QUALITY_MODEL);
}

// ================================================================
// STEP 6: extractActions — Gemini trích xuất action items
// ================================================================

export async function step6_extractActions(
  translatedTurns: TranslatedTurn[],
  summary: SummaryResult,
  config: PipelineConfig
): Promise<ActionItem[]> {
  if (translatedTurns.length === 0) return [];

  const transcriptLog = translatedTurns
    .map((t) => {
      const timeMin = Math.floor(t.start_ms / 60000);
      const timeSec = Math.floor((t.start_ms % 60000) / 1000);
      const timeStr = `${String(timeMin).padStart(2, "0")}:${String(timeSec).padStart(2, "0")}`;
      return `[${timeStr}] ${t.speaker_name}: ${t.translated_text || t.original_text}`;
    })
    .join("\n");

  const prompt = `
Bạn là trợ lý quản lý dự án chuyên nghiệp.
Nhiệm vụ: Trích xuất TẤT CẢ Action Items (công việc cần làm) từ biên bản cuộc họp.

==================================================
THÔNG TIN CUỘC HỌP
==================================================
Tiêu đề: ${config.title}
Ngữ cảnh: ${config.meetingContext || "General discussion"}

TÓM TẮT CUỘC HỌP:
${summary.executive_summary}

QUYẾT ĐỊNH ĐÃ THÔNG QUA:
${summary.decisions.length > 0 ? summary.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n") : "(không có)"}

==================================================
BIÊN BẢN CHI TIẾT
==================================================
${transcriptLog}

==================================================
HƯỚNG DẪN
==================================================
1. Trích xuất MỌI công việc/nhiệm vụ được nhắc đến, kể cả ngầm hiểu.
2. Xác định:
   - description: Mô tả cụ thể công việc
   - owner: Người chịu trách nhiệm (tên hoặc role). Nếu không rõ → null.
   - deadline: Thời hạn dạng ISO 8601 hoặc mô tả ("Thứ Sáu tới", "Cuối tuần", "ASAP"). Nếu không rõ → null.
3. Viết description bằng ngôn ngữ "${config.targetLanguage}".
4. Nếu không có action item nào → trả mảng rỗng.

==================================================
OUTPUT FORMAT — JSON ONLY
==================================================
{
  "action_items": [
    {
      "description": "Nội dung công việc...",
      "owner": "Tên người chịu trách nhiệm hoặc null",
      "deadline": "ISO 8601 hoặc mô tả hoặc null"
    }
  ]
}
`;

  // Dùng AI_QUALITY_MODEL cho bước extract actions
  const result = await callGemini<{ action_items: ActionItem[] }>(prompt, AI_QUALITY_MODEL);
  return result.action_items || [];
}

// ================================================================
// mergeChunks — gộp kết quả từ nhiều chunks, xử lý timestamp offset
// ================================================================

export function mergeChunks(
  allMappedChunks: MappedTurn[][],
  deepgramResults: DeepgramChunkResult[]
): MappedTurn[] {
  if (allMappedChunks.length === 0) return [];
  if (allMappedChunks.length === 1) return allMappedChunks[0];

  const merged: MappedTurn[] = [];

  for (let chunkIdx = 0; chunkIdx < allMappedChunks.length; chunkIdx++) {
    const chunk = allMappedChunks[chunkIdx];
    const offset = deepgramResults[chunkIdx]?.offset_ms || 0;

    for (const turn of chunk) {
      // Cộng offset vào timestamps
      const adjustedTurn: MappedTurn = {
        ...turn,
        start_ms: turn.start_ms + offset,
        end_ms: turn.end_ms + offset,
      };

      // Tại boundary giữa chunks: gộp nếu cùng speaker và khoảng cách < 5 giây
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.speaker_tag === adjustedTurn.speaker_tag &&
        adjustedTurn.start_ms - prev.end_ms < 5000
      ) {
        // Merge vào turn trước
        prev.text = (prev.text + " " + adjustedTurn.text).trim();
        prev.end_ms = adjustedTurn.end_ms;
        prev.confidence = Math.min(prev.confidence, adjustedTurn.confidence);
      } else {
        merged.push(adjustedTurn);
      }
    }
  }

  return merged;
}

// ================================================================
// determineCheckpoint — xác định bước resume từ pipeline_results đã lưu
// ================================================================

export function determineCheckpoint(
  pipelineResults: Record<string, any> | null,
  rawDeepgram: any | null
): PipelineStep {
  if (!pipelineResults) {
    // Nếu chưa có pipeline_results nhưng có raw_deepgram → đã transcribe xong
    if (rawDeepgram) return "correcting";
    return "transcribing";
  }

  const pr = pipelineResults;

  // Kiểm tra ngược từ bước cuối → đầu
  if (pr.action_items) return "saving"; // Đã extract xong, chỉ cần save
  if (pr.summary) return "extracting"; // Đã summarize, cần extract actions
  if (pr.translated_turns) return "summarizing"; // Đã translate, cần summarize
  if (pr.consistency_result) return "translating"; // Đã check, cần translate
  if (pr.merged_turns) return "checking"; // Đã merge, cần consistency check
  if (pr.speaker_mapping) return "checking"; // Đã map speakers, cần merge + check
  if (pr.corrected_turns) return "diarizing"; // Đã correct, cần diarize
  if (rawDeepgram) return "correcting"; // Đã transcribe, cần correct

  return "transcribing";
}

// ================================================================
// runPipeline — orchestrator chính, chạy tất cả bước
// ================================================================

export async function runPipeline(
  meetingId: string,
  audioBuffer: Buffer,
  config: PipelineConfig
): Promise<void> {
  try {
    await updateProgress(meetingId, "transcribing");

    const dgResult = await withRetry(
      meetingId,
      "transcribing",
      async () => {
        const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! });
        const result = await deepgram.listen.v1.media.transcribeFile(audioBuffer, {
          model: "nova-3",
          language: config.sourceLanguage === "auto" ? undefined : config.sourceLanguage,
          smart_format: true,
          diarize: true,
          punctuate: true,
          utterances: true,
          keyterm: config.glossary.map((g) => g.source),
        });
        return result;
      },
      { inputSnapshot: { bufferSize: audioBuffer.length } }
    );

    const supabase = await createServerSupabaseClient();
    await supabase.from("meetings").update({ raw_deepgram_result: dgResult }).eq("id", meetingId);

    const allUtterances = extractUtterancesFromDeepgram(dgResult);
    await saveDeepgramMetadata(meetingId, dgResult, audioBuffer, config);

    // Save RAW transcripts
    await saveRawToTranscripts(meetingId, allUtterances);

    // Set meeting status to ready. Also bump progress to 100% — otherwise it stays frozen
    // at whatever the last updateProgress("transcribing") call left it at (10%), which the
    // home page would display forever if anything ever reads progress instead of status.
    await supabase.from("meetings").update({
      status: "ready",
      progress: { percent: 100, message: "Hoàn tất" },
    }).eq("id", meetingId);

  } catch (err: any) {
    if (err?.message === "CANCELLED") return;
    console.error(`[Pipeline] Fatal error for meeting ${meetingId}:`, err);
    let friendlyMessage = err?.message || "Đã xảy ra lỗi khi xử lý.";
    if (friendlyMessage.includes("Deepgram") || friendlyMessage.includes("transcribe")) {
      friendlyMessage = "Không thể bóc băng âm thanh (Lỗi kết nối máy chủ Deepgram).";
    }
    await updateProgress(meetingId, "failed", undefined, undefined, friendlyMessage);
    throw err;
  }
}

async function saveRawToTranscripts(meetingId: string, utterances: RawUtterance[]) {
  const supabase = await createServerSupabaseClient();

  // Set existing to false (nếu re-upload)
  await supabase.from("transcripts").update({ is_active: false }).eq("meeting_id", meetingId);
  await supabase.from("speakers").update({ is_active: false }).eq("meeting_id", meetingId);

  // Create basic speakers FIRST so transcript rows can link speaker_id (the FK the
  // history page's join actually reads — speaker_tag/speaker_name on transcripts are
  // denormalized text only, never joined against, so without speaker_id every row
  // shows "Unknown" regardless of these columns being set).
  const uniqueTags = Array.from(new Set(utterances.map((u) => `speaker_${u.speaker + 1}`)));
  const tagToSpeakerId: Record<string, string> = {};
  for (const tag of uniqueTags) {
     const { data: newSpeaker } = await supabase.from("speakers").insert({
        meeting_id: meetingId,
        speaker_tag: tag,
        display_name: tag.replace("speaker_", "Speaker "),
        color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
        version_type: 'RAW',
        version: 1,
        is_active: true
     }).select("id").single();
     if (newSpeaker) tagToSpeakerId[tag] = newSpeaker.id;
  }

  const insertRows = utterances.map((u) => {
    const speakerTag = `speaker_${u.speaker + 1}`;
    return {
      meeting_id: meetingId,
      speaker_id: tagToSpeakerId[speakerTag] || null,
      original_text: u.text,
      corrected_text: u.text,
      start_ms: Math.round(Number(u.start * 1000)),
      end_ms: Math.round(Number(u.end * 1000)),
      confidence: u.confidence || 1.0,
      speaker_tag: speakerTag,
      speaker_name: speakerTag.replace("speaker_", "Speaker "),
      version_type: 'RAW',
      version: 1,
      is_active: true
    };
  });

  const insertBatches = chunkArray(insertRows, 100);
  for (const batch of insertBatches) {
    await supabase.from("transcripts").insert(batch);
  }
  
  // Cập nhật raw_transcript vào meetings (text-only backup)
  const rawTranscriptText = insertRows
    .map((t) => `[${t.speaker_name}]: ${t.original_text}`)
    .join("\n");

  const maxEndMs = insertRows.length > 0
    ? Math.max(...insertRows.map((t) => Number(t.end_ms || 0)))
    : 0;

  await supabase
    .from("meetings")
    .update({
      raw_transcript: rawTranscriptText,
      duration_ms: Math.round(maxEndMs),
    })
    .eq("id", meetingId);
}

export async function saveToTables(
  // Deprecated. We use specialized save functions in queueWorker now.
): Promise<void> {}

// ================================================================
// Helper: trích xuất utterances từ Deepgram result
// ================================================================

function extractUtterancesFromDeepgram(dgResult: any): RawUtterance[] {
  // Deepgram Pre-recorded API trả về utterances khi option utterances=true
  if (dgResult?.results?.utterances && dgResult.results.utterances.length > 0) {
    return dgResult.results.utterances.map((u: any) => ({
      text: u.transcript || u.text || "",
      start: u.start || 0,
      end: u.end || 0,
      speaker: u.speaker ?? 0,
      confidence: u.confidence ?? 1.0,
    }));
  }

  // Fallback: nếu không có utterances, dùng words grouped by speaker
  const channel = dgResult?.results?.channels?.[0];
  if (!channel?.alternatives?.[0]?.words) {
    return [];
  }

  const words = channel.alternatives[0].words;
  const utterances: RawUtterance[] = [];
  let currentUtterance: RawUtterance | null = null;

  for (const word of words) {
    const speaker = word.speaker ?? 0;

    if (!currentUtterance || currentUtterance.speaker !== speaker) {
      if (currentUtterance) {
        utterances.push(currentUtterance);
      }
      currentUtterance = {
        text: word.punctuated_word || word.word,
        start: word.start,
        end: word.end,
        speaker,
        confidence: word.confidence,
      };
    } else {
      currentUtterance.text += " " + (word.punctuated_word || word.word);
      currentUtterance.end = word.end;
      currentUtterance.confidence = Math.min(
        currentUtterance.confidence || 1,
        word.confidence || 1
      );
    }
  }

  if (currentUtterance) {
    utterances.push(currentUtterance);
  }

  return utterances;
}

// ================================================================
// Helper: lưu Deepgram metadata vào meeting_metadata
// ================================================================

async function saveDeepgramMetadata(
  meetingId: string,
  dgResult: any,
  audioBuffer: Buffer,
  config: PipelineConfig
): Promise<void> {
  try {
    const supabase = await createServerSupabaseClient();
    const metadata = dgResult?.metadata || {};
    const channels = metadata?.channels || 1;
    const sampleRate = metadata?.sample_rate || null;
    const durationSeconds = metadata?.duration || dgResult?.results?.channels?.[0]?.alternatives?.[0]?.words?.slice(-1)?.[0]?.end || null;

    // Đếm số speakers unique
    const utterances = dgResult?.results?.utterances || [];
    const speakerSet = new Set(utterances.map((u: any) => u.speaker));
    const speakerCount = speakerSet.size || 1;

    // Detect language
    const detectedLanguage = dgResult?.results?.channels?.[0]?.detected_language ||
      config.sourceLanguage;

    // Fetch source_type from meetings to determine created_from
    const { data: meeting } = await supabase
      .from("meetings")
      .select("source_type, status")
      .eq("id", meetingId)
      .single();

    let createdFrom = "live";
    if (meeting?.source_type === "youtube" || meeting?.source_type === "upload") {
      createdFrom = meeting.source_type;
    } else if (meeting?.status === "recording" || meeting?.status === "paused") {
      createdFrom = "live";
    }

    // Check nếu đã có row
    const { data: existing } = await supabase
      .from("meeting_metadata")
      .select("id")
      .eq("meeting_id", meetingId)
      .single();

    const metadataRow = {
      meeting_id: meetingId,
      duration_seconds: durationSeconds ? Math.round(durationSeconds) : null,
      sample_rate: sampleRate,
      channels,
      file_size_bytes: audioBuffer.length,
      detected_language: detectedLanguage,
      speaker_count: speakerCount,
      chunk_count: 1,
      created_from: createdFrom,
    };

    if (existing) {
      await supabase
        .from("meeting_metadata")
        .update(metadataRow)
        .eq("meeting_id", meetingId);
    } else {
      await supabase.from("meeting_metadata").insert(metadataRow);
    }
  } catch (err) {
    // Non-critical — log nhưng không throw
    console.error("[Pipeline] saveDeepgramMetadata error:", err);
  }
}

// ================================================================
// Helper: language labels & instructions (tái sử dụng pattern từ process-transcript-batch)
// ================================================================

function getSourceLangLabel(lang: string): string {
  const labels: Record<string, string> = {
    ja: "Japanese (日本語)",
    en: "English",
    vi: "Vietnamese (Tiếng Việt)",
    auto: "Auto-detect (may be Japanese, English, Vietnamese, or mixed)",
  };
  return labels[lang] || labels["auto"];
}

function getSourceLangInstruction(lang: string): string {
  const instructions: Record<string, string> = {
    ja: `Ngôn ngữ gốc: JAPANESE (日本語)
Dấu hiệu nhận diện người nói:
- Đại từ: 私 (watashi, formal), 僕 (boku, nam casual), 俺 (ore, nam rough)
- Register: です/ます (lịch sự) vs だ/ね (casual)
- Trợ từ cuối câu: よ, ね, か, わ, ぞ
- Kính ngữ: 〜さん, 〜先生, 〜様
- Aizuchi: なるほど, うん, はい, そうですね, ええ, あー`,

    en: `Ngôn ngữ gốc: ENGLISH
Dấu hiệu nhận diện người nói:
- Pronouns: I/me vs you, we vs they
- Question vs statement patterns
- Formal ("Could you please...") vs casual ("Hey, so...")
- Backchannels: yeah, okay, I see, right, uh-huh, sure, got it`,

    vi: `Ngôn ngữ gốc: VIETNAMESE (Tiếng Việt)
Dấu hiệu nhận diện người nói:
- Đại từ: tôi/mình (tôi, trung lập), anh/chị/em (theo giới/tuổi), ông/bà (người lớn tuổi)
- Register: formal (thưa, kính, ạ) vs casual (ừ, ờ, nhé, nha)
- Trợ từ cuối câu: ạ, nhé, nha, nhỉ, hả, à
- Backchannels: vâng, dạ, ừ, thế à, đúng rồi, à ra vậy`,

    auto: `Ngôn ngữ gốc: AUTO-DETECT (có thể là Japanese, English, Vietnamese, hoặc mixed)
Áp dụng TẤT CẢ dấu hiệu nhận diện ngôn ngữ:
- Japanese: Đại từ (私/僕/俺), register (です・ます vs だ・ね), aizuchi (なるほど, うん, はい)
- English: Pronouns (I/you), question patterns, backchannels (yeah, okay, I see)
- Vietnamese: Đại từ (tôi/anh/chị/em), trợ từ (ạ/nhé/nha), backchannels (vâng, dạ, ừ)
- QUAN TRỌNG: Theo dõi speaker nào dùng ngôn ngữ nào — chuyển ngôn ngữ là tín hiệu mạnh về chuyển người nói.`,
  };

  return instructions[lang] || instructions["auto"];
}
