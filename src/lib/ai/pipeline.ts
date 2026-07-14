// ================================================================
// Pipeline AI xử lý transcript cho Upload / YouTube
// 6 bước: correctSTT → speakerMapping → consistencyCheck → translate → summarize → extractActions
// Chunking: audio > 10 phút chia thành chunks. Bước 1-2 per chunk, merge, rồi 3-6 trên toàn bộ.
// ================================================================

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { DeepgramClient } from "@deepgram/sdk";
import { runWithGeminiClient } from "./geminiClient";

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

// Flash-lite là model mặc định cho TOÀN pipeline (nhanh + rẻ, đủ cho các tác vụ này).
// AI_QUALITY_MODEL vẫn giữ để có thể nâng riêng các bước "nặng" (summary/speaker) qua
// biến môi trường nếu sau này thấy cần chất lượng cao hơn — mặc định vẫn là flash-lite.
const AI_FAST_MODEL = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
const AI_QUALITY_MODEL = process.env.AI_QUALITY_MODEL || "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";

const BATCH_SIZE = 30;

// Khoảng nghỉ giữa các batch gọi Gemini (chống rate-limit). Mặc định 1000ms (nhanh ~2.5× so
// với 2500ms trước đây) — an toàn với flash-lite (RPM cao) vì callGemini đã có fallback + retry
// backoff nếu lỡ gặp 429. Có thể chỉnh qua env AI_BATCH_DELAY_MS (vd nâng lên 2500 nếu gói thấp).
const BATCH_DELAY_MS = Number(process.env.AI_BATCH_DELAY_MS) || 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Gọi Gemini với model chỉ định, tự fallback sang gemini-3.1-flash-lite nếu lỗi.
 * Trả về parsed JSON object.
 */
export async function callGemini<T = any>(
  prompt: string,
  modelName: string,
  options?: { temperature?: number; responseSchema?: any; maxOutputTokens?: number }
): Promise<T> {
  // temperature thấp (0) cho các pass "trung thành" (sửa lỗi, dịch): giảm việc model tự
  // diễn giải/viết lại → giữ ngữ nghĩa và cho kết quả ổn định hơn. Bỏ qua nếu không truyền.
  const generationConfig: Record<string, unknown> = { responseMimeType: "application/json" };
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  // responseSchema: ép Gemini trả JSON đúng cấu trúc + escape chuẩn → tránh JSON hỏng
  // ("Expected ',' or '}'") vốn hay xảy ra khi text chứa dấu ngoặc kép / xuống dòng.
  if (options?.responseSchema !== undefined) generationConfig.responseSchema = options.responseSchema;
  // maxOutputTokens cao để output dài (nhiều dòng + bản dịch) không bị cắt ngang giữa JSON.
  if (options?.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;

  return runWithGeminiClient(async (genAI) => {
    let result;
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig,
      });
      result = await model.generateContent(prompt);
    } catch (err) {
      console.warn(`Model ${modelName} failed, falling back to ${FALLBACK_MODEL}:`, err);
      const fallbackModel = genAI.getGenerativeModel({
        model: FALLBACK_MODEL,
        generationConfig,
      });
      result = await fallbackModel.generateContent(prompt);
    }
    return result;
  }).then((result) => {
    let responseText = result.response.text().trim();
    // Robustly extract JSON — loại bỏ markdown wrappers nếu có
    const startIdx = responseText.indexOf("{");
    const endIdx = responseText.lastIndexOf("}");
    const arrStartIdx = responseText.indexOf("[");
    const arrEndIdx = responseText.lastIndexOf("]");

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      if (arrStartIdx !== -1 && arrStartIdx < startIdx) {
        responseText = responseText.substring(arrStartIdx, arrEndIdx + 1);
      } else {
        responseText = responseText.substring(startIdx, endIdx + 1);
      }
    } else if (arrStartIdx !== -1 && arrEndIdx !== -1 && arrEndIdx > arrStartIdx) {
      responseText = responseText.substring(arrStartIdx, arrEndIdx + 1);
    }
    return robustParseJSON<T>(responseText);
  });
}

// We can keep getGeminiClient for other uses, but updated to use key rotation
import { getGeminiClient } from "./geminiClient";

function robustParseJSON<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err: any) {
    const match = err.message.match(/at position (\d+)/i);
    if (match) {
      const pos = parseInt(match[1], 10);
      try {
        return JSON.parse(text.substring(0, pos)) as T;
      } catch (innerErr) {
        throw err;
      }
    }
    throw err;
  }
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
// STEP 5: summarize — Gemini tóm tắt + decisions (AI_QUALITY_MODEL)
// ================================================================

function getSummaryModeInstructions(mode: string | null | undefined, targetLanguage: string): string {
  switch (mode) {
    case "detailed":
      return `
NHIỆM VỤ: Tạo BẢN CHI TIẾT CUỘC TRAO ĐỔI cực kỳ đầy đủ, phân tích chi tiết từng chủ đề bằng Markdown.

HƯỚNG DẪN CẤU TRÚC VÀ ĐỊNH DẠNG BẮT BUỘC:
1. Định dạng văn bản chính xác theo cấu trúc sau:
# BẢN CHI TIẾT CUỘC TRAO ĐỔI

**Chủ đề:** [Tên chủ đề thực tế của cuộc họp/trao đổi]

## 1. Mở đầu
[Nội dung tóm tắt chi tiết phần mở đầu cuộc trao đổi, chào hỏi, giới thiệu nhân vật...]

## 2. [Chủ đề thảo luận chính thứ nhất]
[Nội dung phân tích chi tiết, đầy đủ câu chuyện, lập luận, trải nghiệm của từng thành viên liên quan đến chủ đề này...]

## 3. [Chủ đề thảo luận chính thứ hai]
[Nội dung phân tích chi tiết...]

(Tiếp tục phân tích toàn bộ cuộc hội thoại bằng các đề mục đánh số ## 4, ## 5, ## 6... cho đến hết mọi khía cạnh được thảo luận)

### Nội dung thống nhất
* [Ý kiến/Quyết định thống nhất 1...]
* [Ý kiến/Quyết định thống nhất 2...]

### Công việc cần thực hiện
**[Nếu có công việc cần làm, ghi mô tả ngắn gọn. Nếu không phát sinh công việc hoặc hành động tiếp theo, bắt buộc phải ghi nguyên văn dòng chữ đậm sau: "Không phát sinh nhiệm vụ hoặc nội dung cần theo dõi sau cuộc trao đổi."]**

2. YÊU CẦU QUAN TRỌNG:
- Tiêu đề chính bắt đầu bằng một dấu thăng (#) duy nhất: "# BẢN CHI TIẾT CUỘC TRAO ĐỔI"
- Các tiêu đề chủ đề thảo luận bắt đầu bằng hai dấu thăng (##) và được đánh số thứ tự (ví dụ: ## 1. Mở đầu, ## 2. ...).
- Mỗi mục chủ đề phải là một đoạn văn tóm tắt chi tiết, dày dặn, không viết chung chung sơ sài.
- Các phần "Nội dung thống nhất" và "Công việc cần thực hiện" ở cuối bắt đầu bằng ba dấu thăng (###) và tuân thủ cách định dạng danh sách/chữ in đậm như mẫu.
- Viết bằng ngôn ngữ "${targetLanguage}".
- Tuyệt đối không tự bịa ra thông tin không có trong cuộc họp.

OUTPUT FORMAT — JSON ONLY:
{
  "executive_summary": "# BẢN CHI TIẾT CUỘC TRAO ĐỔI\\n\\n**Chủ đề:** ...\\n\\n## 1. Mở đầu\\n...\\n\\n## 2. ...\\n\\n### Nội dung thống nhất\\n* ...\\n\\n### Công việc cần thực hiện\\n**...**",
  "decisions": ["Quyết định 1...", "Quyết định 2..."]
}`;

    case "bullets":
      return `
NHIỆM VỤ: Trích xuất CÁC ĐIỂM CHÍNH dưới dạng gạch đầu dòng (bullet points).

HƯỚNG DẪN:
1. Tổng hợp các điểm quan trọng nhất của cuộc họp.
2. Mỗi điểm là một câu ngắn gọn, súc tích.
3. Sắp xếp theo thứ tự quan trọng giảm dần.
4. Tối đa 10-15 điểm chính.
5. Viết bằng ngôn ngữ "${targetLanguage}".
6. Không hallucinate thông tin không có trong biên bản.

OUTPUT FORMAT — JSON ONLY:
{
  "executive_summary": "• Điểm chính 1\\n• Điểm chính 2\\n• Điểm chính 3...",
  "decisions": ["Quyết định 1...", "Quyết định 2..."]
}`;

    case "meeting_minutes":
      return `
NHIỆM VỤ: Tạo BIÊN BẢN CUỘC HỌP chi tiết, rõ ràng theo đúng cấu trúc và định dạng của phiên bản cũ bằng Markdown.

HƯỚNG DẪN CẤU TRÚC VÀ ĐỊNH DẠNG BẮT BUỘC:
1. Viết biên bản theo đúng định dạng cấu trúc sau (lưu ý tăng kích thước tiêu đề phần bằng ##, đưa dấu hai chấm ra ngoài phần in đậm **, và phân tách rõ ràng các ý thảo luận bằng gạch đầu dòng con thụt lề):

# BIÊN BẢN CUỘC HỌP

## 1. THÔNG TIN CHUNG
- **Ngày**: [Ngày diễn ra cuộc họp/trao đổi]
- **Chủ đề**: [Tên chủ đề hoặc nội dung chính]
- **Người tham gia**: [Tên những người tham gia và vai trò ngắn gọn]

---

## 2. NỘI DUNG THẢO LUẬN
- **[Chủ đề thảo luận 1]**: [Tóm tắt khái quát chủ đề].
  - [Ý chi tiết/Ý phụ 1 của chủ đề 1]
  - [Ý chi tiết/Ý phụ 2 của chủ đề 1]
  - [Ý chi tiết/Ý phụ 3 của chủ đề 1]
- **[Chủ đề thảo luận 2]**: [Tóm tắt khái quát].
  - [Ý chi tiết/Ý phụ 1 của chủ đề 2]
  - [Ý chi tiết/Ý phụ 2 của chủ đề 2]
- **[Chủ đề thảo luận 3]**: [Tóm tắt khái quát].
  - [Ý chi tiết/Ý phụ 1 của chủ đề 3]

---

## 3. QUYẾT ĐỊNH
- [Quyết định hoặc ý kiến thống nhất 1...]
- [Quyết định hoặc ý kiến thống nhất 2...]

---

## 4. CÔNG VIỆC TIẾP THEO
- [Công việc cần thực hiện tiếp theo 1. Nếu không phát sinh công việc hoặc hành động tiếp theo, ghi nguyên văn: "Không phát sinh công việc, nhiệm vụ hoặc nội dung cần theo dõi sau cuộc trao đổi."]

2. YÊU CẦU QUAN TRỌNG:
- Tiêu đề chính "BIÊN BẢN CUỘC HỌP" bắt đầu bằng một dấu thăng (#) duy nhất để đạt kích thước lớn nhất.
- Các tiêu đề phần bắt đầu bằng hai dấu thăng (##) để tăng kích thước chữ lớn hơn phiên bản trước.
- Dấu hai chấm (:) của các nhãn ở phần 1 và các tiêu đề thảo luận ở phần 2 phải nằm NGOÀI phần in đậm (ví dụ viết là: **Ngày**: hoặc **Lựa chọn quốc gia**: chứ KHÔNG viết **Ngày:** hoặc **Lựa chọn quốc gia**:).
- **YÊU CẦU BẮT BUỘC VỀ GẠCH ĐẦU DÒNG CON (NESTED BULLETS)**: 
  * Các câu bắt đầu có chữ in đậm (ví dụ: "- **Lựa chọn quốc gia**: ...") được gán làm gạch đầu dòng cha (sử dụng dấu gạch ngang "-").
  * Tất cả các ý phụ giải thích tiếp theo, thông tin chi tiết hoặc lập luận đi kèm của chủ đề đó **BẮT BUỘC** phải thụt lề vào trong bằng 2 khoảng trắng và dấu gạch ngang (viết là: "  - [Nội dung ý phụ...]").
  * **TUYỆT ĐỐI KHÔNG** đặt các ý phụ ở ngoài cùng dòng cha hoặc sử dụng cùng một mức gạch đầu dòng phẳng với dòng tiêu đề in đậm. Phải có sự phân hóa phân cấp rõ ràng bằng thụt lề.
- Biên bản phải CỰC KỲ CHI TIẾT và RÕ RÀNG, tóm tắt đầy đủ mọi thông tin, các điểm nhấn và các câu chuyện thực tế được thảo luận trong cuộc họp.
- Sử dụng đúng định dạng Markdown (tiêu đề #, ##, in đậm **, gạch đầu dòng -, đường kẻ ngang --- để ngăn cách các mục).
- Viết bằng ngôn ngữ "${targetLanguage}".
- Tuyệt đối không tự bịa ra thông tin không có trong cuộc họp.

OUTPUT FORMAT — JSON ONLY:
{
  "executive_summary": "# BIÊN BẢN CUỘC HỌP\\n\\n## 1. THÔNG TIN CHUNG\\n- **Ngày**: ...\\n- **Chủ đề**: ...\\n- **Người tham gia**: ...\\n\\n---\\n\\n## 2. NỘI DUNG THẢO LUẬN\\n- **...**: ...\\n  - ...\\n\\n---\\n\\n## 3. QUYẾT ĐỊNH\\n...\\n\\n---\\n\\n## 4. CÔNG VIỆC TIẾP THEO\\n...",
  "decisions": ["Điểm thống nhất 1...", "Điểm thống nhất 2..."]
}`;

    case "action_items_only":
      return `
NHIỆM VỤ: CHỈ trích xuất CÔNG VIỆC CẦN LÀM (Action Items) từ cuộc họp.

HƯỚNG DẪN:
1. Tìm mọi công việc, cam kết, nhiệm vụ được nhắc đến.
2. Tóm tắt ngắn gọn chỉ liên quan đến action items.
3. Viết bằng ngôn ngữ "${targetLanguage}".
4. Không hallucinate thông tin không có trong biên bản.

OUTPUT FORMAT — JSON ONLY:
{
  "executive_summary": "Tóm tắt các công việc cần thực hiện sau cuộc họp...",
  "decisions": ["Quyết định liên quan đến phân công 1...", "Quyết định 2..."]
}`;

    default:
      // Default: standard summary
      return `
NHIỆM VỤ: Tạo BÁO CÁO TÓM TẮT chất lượng cao.

HƯỚNG DẪN:
1. Executive Summary: Đoạn văn ngắn gọn mô tả mục đích và kết quả chung.
2. Key Decisions: Danh sách các quyết định/thỏa thuận quan trọng.
3. Viết bằng ngôn ngữ "${targetLanguage}".
4. Nếu không có quyết định rõ ràng, trả mảng rỗng.
5. Không hallucinate thông tin không có trong biên bản.

OUTPUT FORMAT — JSON ONLY:
{
  "executive_summary": "nội dung tóm tắt tổng quan cuộc họp...",
  "decisions": ["Quyết định thứ nhất...", "Quyết định thứ hai..."]
}`;
  }
}

// Structured-output schema cho tóm tắt + action items → ép JSON hợp lệ, tránh lỗi
// "Expected ',' or '}'" khi output dài (biên bản dài, nhiều quyết định/công việc).
const SUMMARY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    executive_summary: { type: SchemaType.STRING },
    decisions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["executive_summary", "decisions"],
};

const ACTIONS_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    action_items: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          description: { type: SchemaType.STRING },
          owner: { type: SchemaType.STRING, nullable: true },
          deadline: { type: SchemaType.STRING, nullable: true },
        },
        required: ["description"],
      },
    },
  },
  required: ["action_items"],
};

export async function step5_summarize(
  translatedTurns: TranslatedTurn[],
  config: PipelineConfig,
  mode?: string | null
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

  // Build mode-specific instructions
  const modeInstructions = getSummaryModeInstructions(mode, config.targetLanguage);

  const prompt = `
Bạn là một thư ký cuộc họp chuyên nghiệp sử dụng mô hình trí tuệ nhân tạo chất lượng cao.

Thông tin cuộc họp:
- Tiêu đề: ${config.title}
- Ngữ cảnh: ${config.meetingContext || "General discussion"}
- Ngôn ngữ gốc: ${getSourceLangLabel(config.sourceLanguage)}
- Ngôn ngữ đích: ${config.targetLanguage}

Biên bản cuộc họp cần phân tích:
---
${transcriptLog}
---

${modeInstructions}
`;

  // Dùng AI_QUALITY_MODEL cho bước summary; structured output tránh JSON hỏng khi biên bản dài.
  return await callGemini<SummaryResult>(prompt, AI_QUALITY_MODEL, {
    responseSchema: SUMMARY_SCHEMA,
    maxOutputTokens: 8192,
  });
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
HƯỚNG DẪN BẮT BUỘC
==================================================
1. Trích xuất MỌI công việc/nhiệm vụ được nhắc đến hoặc ngầm hiểu trong cuộc họp.
2. Với mỗi công việc, xác định các trường:
   - description: Mô tả cụ thể công việc bằng ngôn ngữ "${config.targetLanguage}".
   - owner: Chỉ điền TÊN hoặc VAI TRÒ ngắn gọn của người chịu trách nhiệm (ví dụ: "Shun", "Haruka", "Quản lý").
     * TUYỆT ĐỐI KHÔNG viết giải thích, lập luận hay văn tự dài dòng giải thích lý do vào trường này.
     * Nếu không rõ người chịu trách nhiệm hoặc là sự hợp tác chung không có cá nhân cụ thể → Gán giá trị JSON null (không điền text giải thích, không điền chuỗi "null").
   - deadline: Thời hạn thực hiện (ví dụ: "2026-07-20", "Thứ Sáu tới", "ASAP").
     * TUYỆT ĐỐI KHÔNG viết giải thích dài dòng vào trường này.
     * Nếu không rõ thời hạn → Gán giá trị JSON null.
3. Nếu không có action item nào → trả mảng rỗng [].

==================================================
OUTPUT FORMAT — JSON ONLY
==================================================
{
  "action_items": [
    {
      "description": "Nội dung công việc...",
      "owner": null,
      "deadline": null
    }
  ]
}
`;

  // Dùng AI_QUALITY_MODEL cho bước extract actions; structured output tránh JSON hỏng.
  const result = await callGemini<{ action_items: ActionItem[] }>(prompt, AI_QUALITY_MODEL, {
    responseSchema: ACTIONS_SCHEMA,
    maxOutputTokens: 8192,
  });
  return result.action_items || [];
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

    await saveDeepgramMetadata(meetingId, dgResult, audioBuffer, config);

    // Model 2-bản: RAW chỉ là 1 blob text (meetings.raw_transcript) + JSON word-level
    // (raw_deepgram_result). KHÔNG tạo dòng trong transcripts — các dòng đã-xử-lý sẽ do
    // job "process" sinh ra sau.
    await saveRawBlob(meetingId, dgResult);

    // RAW xong → chuyển sang giai đoạn xử lý AI. Worker (job process/summary) sẽ set "completed".
    await supabase.from("meetings").update({
      status: "processing",
      progress: { percent: 40, message: "Đã bóc băng, đang xử lý AI..." },
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

// Lưu BẢN THÔ (RAW) dạng blob: text thô của Deepgram + duration. KHÔNG tạo dòng transcripts,
// KHÔNG tạo speakers — đó là việc của job "process". raw_deepgram_result (word-level JSON) đã
// được lưu trước đó và là nguồn timestamp cho bước xử lý.
async function saveRawBlob(meetingId: string, dgResult: any) {
  const supabase = await createServerSupabaseClient();

  const alt = dgResult?.results?.channels?.[0]?.alternatives?.[0];
  const rawText: string = alt?.transcript || "";
  const words = alt?.words || [];
  const lastEnd = words.length > 0 ? Number(words[words.length - 1].end || 0) : Number(dgResult?.metadata?.duration || 0);

  await supabase
    .from("meetings")
    .update({
      raw_transcript: rawText,
      duration_ms: Math.round(lastEnd * 1000),
    })
    .eq("id", meetingId);
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

export function getSourceLangLabel(lang: string): string {
  const labels: Record<string, string> = {
    ja: "Japanese (日本語)",
    en: "English",
    vi: "Vietnamese (Tiếng Việt)",
    auto: "Auto-detect (may be Japanese, English, Vietnamese, or mixed)",
  };
  return labels[lang] || labels["auto"];
}

