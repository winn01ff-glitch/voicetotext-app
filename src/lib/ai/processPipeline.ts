// ================================================================
// Pipeline xử lý HỢP NHẤT (model 2-bản)
// ----------------------------------------------------------------
// Đầu vào: RAW của Deepgram (word-level) đã lưu ở meetings.raw_deepgram_result.
// AI đọc TOÀN BỘ word (được phép gộp/tách dòng theo ngữ cảnh + người nói) và trả về
// các dòng đã xử lý; MỖI dòng kèm word_start/word_end (chỉ số từ GLOBAL) → code tự tính
// start_ms/end_ms từ timestamp của Deepgram (AI không bịa số — phương án A).
//
// Một lượt AI làm hết: cắt dòng + phân vai + sửa chính tả + dịch. Batch theo cửa sổ từ,
// chạy SONG SONG (concurrency pool), không sleep cố định.
// ================================================================

import { SchemaType } from "@google/generative-ai";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PipelineConfig, callGemini, getSourceLangLabel } from "./pipeline";
import { createHash } from "crypto";

const AI_MODEL = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";

// Cửa sổ từ cho mỗi lần gọi AI. ~300 từ: output/chunk nhỏ hơn → ít nguy cơ bị cắt ngang JSON,
// mỗi call nhanh hơn; bù lại nhiều chunk hơn nhưng chúng chạy song song.
const WORDS_PER_CHUNK = Number(process.env.AI_WORDS_PER_CHUNK) || 300;
// Số từ ngữ-cảnh (chỉ để model đọc, KHÔNG emit lại) nối từ cuối chunk trước.
const CONTEXT_WORDS = 40;
// Số chunk chạy song song cùng lúc (flash-lite RPM cao + key rotation chịu được).
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 8;
// Trần output token/chunk — đủ lớn để nhiều dòng + bản dịch không bị cắt giữa JSON.
const MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS) || 8192;

// Schema ép Gemini trả JSON đúng cấu trúc (structured output) → loại bỏ JSON hỏng.
const LINES_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    lines: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          word_start: { type: SchemaType.INTEGER },
          word_end: { type: SchemaType.INTEGER },
          speaker_tag: { type: SchemaType.STRING },
          speaker_name: { type: SchemaType.STRING },
          text: { type: SchemaType.STRING },
          translated_text: { type: SchemaType.STRING },
        },
        required: ["word_start", "word_end", "speaker_tag", "speaker_name", "text", "translated_text"],
      },
    },
  },
  required: ["lines"],
};

// ================================================================
// Types
// ================================================================

/** Một từ thô từ Deepgram (đã phẳng hoá + có chỉ số toàn cục) */
export interface DgWord {
  w: string;       // punctuated_word || word
  start: number;   // giây
  end: number;     // giây
  speaker: number; // speaker hint (0-indexed) từ diarization của Deepgram
}

/** Dòng do AI trả về (chưa map timestamp) */
interface AiLine {
  word_start: number;
  word_end: number;
  speaker_tag: string;
  speaker_name: string;
  text: string;            // đã sửa, NGÔN NGỮ GỐC
  translated_text: string; // bản dịch sang target
}

/** Dòng đã xử lý xong (đã có timestamp) — sẵn sàng ghi transcripts */
export interface ProcessedLine {
  original_text: string;
  translated_text: string;
  speaker_tag: string;
  speaker_name: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
}

// ================================================================
// Trích xuất danh sách từ (word-level) từ Deepgram result
// ================================================================

export function extractWords(dgResult: any): DgWord[] {
  const words = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words) || words.length === 0) return [];
  return words.map((w: any) => ({
    w: w.punctuated_word || w.word || "",
    start: typeof w.start === "number" ? w.start : 0,
    end: typeof w.end === "number" ? w.end : 0,
    speaker: typeof w.speaker === "number" ? w.speaker : 0,
  }));
}

// ================================================================
// Concurrency pool — chạy fn cho từng item, tối đa `limit` cùng lúc, giữ đúng thứ tự kết quả
// ================================================================

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ================================================================
// Chia words thành các chunk theo cửa sổ, kèm context-text của chunk trước
// ================================================================

interface WordChunk {
  startIdx: number;   // chỉ số global bắt đầu (inclusive)
  endIdx: number;     // chỉ số global kết thúc (exclusive)
  contextText: string; // text ~CONTEXT_WORDS từ ngay trước, chỉ để đọc
}

function buildChunks(words: DgWord[]): WordChunk[] {
  const chunks: WordChunk[] = [];
  for (let start = 0; start < words.length; start += WORDS_PER_CHUNK) {
    const end = Math.min(start + WORDS_PER_CHUNK, words.length);
    const ctxFrom = Math.max(0, start - CONTEXT_WORDS);
    const contextText = start > 0
      ? words.slice(ctxFrom, start).map((x) => x.w).join(" ")
      : "";
    chunks.push({ startIdx: start, endIdx: end, contextText });
  }
  return chunks;
}

// ================================================================
// Gọi AI cho 1 chunk
// ================================================================

// Hướng dẫn bổ sung cho bước PHÂN VAI theo mode user chọn ở tab Hội thoại.
function getSpeakerModeInstruction(mode: string | null | undefined): string {
  switch (mode) {
    case "by_name":
      return `\nPHÂN VAI — CHẾ ĐỘ THEO TÊN: tích cực suy ra TÊN THẬT của người nói từ nội dung (xưng hô, giới thiệu, gọi tên). Ưu tiên tên thật thay vì "Speaker N".`;
    case "single_speaker_split":
      return `\nPHÂN VAI — CHẾ ĐỘ ĐỘC THOẠI (1 người nói): TẤT CẢ dòng gán chung "speaker_1", speaker_name = "Diễn giả". KHÔNG gộp thành 1 khối lớn — giữ các dòng ngắn theo câu để dễ đọc.`;
    case "numbered":
      return `\nPHÂN VAI — CHẾ ĐỘ ĐÁNH SỐ: KHÔNG đoán tên thật. Dùng "Speaker 1", "Speaker 2"... Tập trung phân tách CHÍNH XÁC ai nói câu nào.`;
    case "by_role":
      return `\nPHÂN VAI — CHẾ ĐỘ THEO VAI TRÒ: gán speaker_name theo vai trò (Quản lý, Nhân viên, Khách hàng, Phỏng vấn viên, Ứng viên...) suy từ nội dung; nếu không rõ dùng "Người tham gia N".`;
    case "merge_speakers":
      return `\nPHÂN VAI — CHẾ ĐỘ GỘP: tích cực gộp các speaker có thể là cùng 1 người (ASR tách nhầm). So sánh register/từ vựng/chủ đề; ưu tiên gộp khi không chắc.`;
    default:
      return ``; // mặc định: dùng speaker đã đăng ký + ngữ cảnh (như prompt gốc)
  }
}

function buildPrompt(
  words: DgWord[],
  chunk: WordChunk,
  config: PipelineConfig,
  mode?: string | null
): string {
  // Cấp cho model list từ có chỉ số GLOBAL + speaker hint. KHÔNG cấp timestamp.
  const inputWords = [];
  for (let i = chunk.startIdx; i < chunk.endIdx; i++) {
    inputWords.push({ i, w: words[i].w, s: words[i].speaker });
  }

  const glossaryStr = config.glossary.length > 0
    ? JSON.stringify(config.glossary.map((g) => ({ source: g.source, target: g.target })))
    : "(không có)";

  const speakersStr = config.speakers.length > 0
    ? JSON.stringify(config.speakers.map((s) => ({ speaker_tag: s.speaker_tag, display_name: s.display_name })))
    : "(chưa đăng ký — tự đặt speaker_1, speaker_2...)";

  return `
Bạn là chuyên gia xử lý biên bản hội thoại. Đầu vào là output STT THÔ của Deepgram ở dạng
DANH SÁCH TỪ (word-level), mỗi từ có: "i" = chỉ số toàn cục, "w" = từ, "s" = gợi ý người nói
(0-indexed) từ phân tách âm thanh của Deepgram.

Nhiệm vụ (LÀM TẤT CẢ trong 1 lượt, đọc toàn bộ để hiểu ngữ cảnh):
1. CẮT DÒNG (segment): gộp/tách các từ thành các lượt thoại tự nhiên theo NGỮ CẢNH và NGƯỜI NÓI.
   - Được phép gộp nhiều câu liên tiếp cùng người thành 1 dòng, hoặc tách 1 chuỗi thành nhiều dòng.
2. PHÂN VAI: gán speaker_tag ("speaker_1", "speaker_2"...) cho mỗi dòng. Dùng gợi ý "s" nhưng VERIFY
   bằng nội dung (đại từ, cách xưng hô, register). speaker_name = tên thật nếu suy ra được, nếu không thì "Speaker N".
3. SỬA CHÍNH TẢ: sửa lỗi ASR rõ ràng, thêm dấu câu hợp lý cho dòng "text" (GIỮ NGÔN NGỮ GỐC).
   - GIỮ NGUYÊN chính xác: số, ngày giờ, đơn vị, tiền tệ, %, tên riêng. KHÔNG thêm/bớt ý.
4. DỊCH: "translated_text" = bản dịch của dòng sang ngôn ngữ đích. Nếu dòng ĐÃ là ngôn ngữ đích thì copy nguyên.

RÀNG BUỘC TIMESTAMP (quan trọng):
- Mỗi dòng PHẢI có "word_start" và "word_end" = chỉ số "i" (toàn cục) của từ ĐẦU và CUỐI thuộc dòng đó (inclusive).
- Phủ HẾT các từ trong chunk theo thứ tự tăng dần, KHÔNG chồng lấn, KHÔNG bỏ sót từ.
- word_start/word_end phải nằm trong khoảng [${chunk.startIdx}, ${chunk.endIdx - 1}].

==================================================
NGÔN NGỮ GỐC: ${getSourceLangLabel(config.sourceLanguage)}
NGÔN NGỮ ĐÍCH: ${config.targetLanguage}
TIÊU ĐỀ: ${config.title}
NGỮ CẢNH: ${config.meetingContext || "General discussion"}
NGƯỜI NÓI ĐÃ ĐĂNG KÝ: ${speakersStr}
GLOSSARY (ưu tiên khi khớp): ${glossaryStr}${getSpeakerModeInstruction(mode)}
${chunk.contextText ? `\nNGỮ CẢNH TRƯỚC ĐÓ (chỉ để hiểu, KHÔNG xử lý lại): "${chunk.contextText}"` : ""}
==================================================
DANH SÁCH TỪ CẦN XỬ LÝ (JSON):
${JSON.stringify(inputWords)}

==================================================
OUTPUT — CHỈ JSON, không markdown:
{
  "lines": [
    { "word_start": ${chunk.startIdx}, "word_end": ${chunk.startIdx}, "speaker_tag": "speaker_1", "speaker_name": "Tên", "text": "câu đã sửa (ngôn ngữ gốc)", "translated_text": "bản dịch" }
  ]
}
`;
}

// Fallback khi AI lỗi/trả rỗng cho 1 chunk: giữ nguyên câu THÔ, gộp các từ liên tiếp cùng
// speaker-hint thành 1 dòng (không dịch). Cô lập lỗi để KHÔNG kéo cả job retry lại từ đầu.
function passthroughChunk(words: DgWord[], chunk: WordChunk): ProcessedLine[] {
  const out: ProcessedLine[] = [];
  let i = chunk.startIdx;
  while (i < chunk.endIdx) {
    const spk = words[i].speaker;
    let j = i;
    while (j < chunk.endIdx && words[j].speaker === spk) j++;
    const text = words.slice(i, j).map((w) => w.w).join(" ").trim();
    if (text) {
      out.push({
        original_text: text,
        translated_text: "",
        speaker_tag: `speaker_${spk + 1}`,
        speaker_name: `Speaker ${spk + 1}`,
        start_ms: Math.round((words[i].start ?? 0) * 1000),
        end_ms: Math.round((words[j - 1].end ?? 0) * 1000),
        confidence: 1.0,
      });
    }
    i = j;
  }
  return out;
}

async function processChunk(
  words: DgWord[],
  chunk: WordChunk,
  config: PipelineConfig,
  mode?: string | null
): Promise<ProcessedLine[]> {
  const prompt = buildPrompt(words, chunk, config, mode);

  let lines: AiLine[] = [];
  try {
    const result = await callGemini<{ lines: AiLine[] }>(prompt, AI_MODEL, {
      temperature: 0,
      responseSchema: LINES_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    lines = Array.isArray(result?.lines) ? result.lines : [];
  } catch (err) {
    console.warn(
      `[processChunk] AI lỗi cho chunk [${chunk.startIdx}, ${chunk.endIdx}) — dùng passthrough:`,
      (err as any)?.message || err
    );
  }

  // Cô lập lỗi: chunk hỏng/rỗng → giữ câu thô, không làm cả job fail rồi retry toàn bộ.
  if (lines.length === 0) return passthroughChunk(words, chunk);

  const clamp = (i: number) => Math.max(chunk.startIdx, Math.min(chunk.endIdx - 1, Math.floor(i)));
  const out: ProcessedLine[] = [];

  for (const ln of lines) {
    if (!ln || typeof ln.text !== "string") continue;
    let ws = clamp(Number(ln.word_start));
    let we = clamp(Number(ln.word_end));
    if (we < ws) we = ws;

    // Timestamp lấy TRỰC TIẾP từ Deepgram theo word range — không tin số của model.
    const start_ms = Math.round((words[ws]?.start ?? 0) * 1000);
    const end_ms = Math.round((words[we]?.end ?? words[ws]?.end ?? 0) * 1000);

    // Confidence: min confidence không có ở word (đã bỏ), dùng 1.0; speaker hint fallback.
    const hint = words[ws]?.speaker ?? 0;
    const speaker_tag = (ln.speaker_tag && /^speaker_\d+$/.test(ln.speaker_tag))
      ? ln.speaker_tag
      : `speaker_${hint + 1}`;

    out.push({
      original_text: ln.text.trim(),
      translated_text: (ln.translated_text ?? "").trim(),
      speaker_tag,
      speaker_name: (ln.speaker_name || speaker_tag.replace("speaker_", "Speaker ")).trim(),
      start_ms,
      end_ms,
      confidence: 1.0,
    });
  }

  return out.length > 0 ? out : passthroughChunk(words, chunk);
}

// ================================================================
// Ghép các chunk + gộp nhẹ ở ranh giới (cùng speaker, sát nhau)
// ================================================================

function stitch(chunkResults: ProcessedLine[][]): ProcessedLine[] {
  const merged: ProcessedLine[] = [];
  for (const lines of chunkResults) {
    for (const line of lines) {
      const prev = merged[merged.length - 1];
      // Gộp nếu cùng speaker và khoảng cách < 2s (thường là 1 câu bị cắt ở ranh giới chunk).
      if (prev && prev.speaker_tag === line.speaker_tag && line.start_ms - prev.end_ms < 2000 && line.start_ms >= prev.start_ms) {
        prev.original_text = `${prev.original_text} ${line.original_text}`.trim();
        prev.translated_text = `${prev.translated_text} ${line.translated_text}`.trim();
        prev.end_ms = Math.max(prev.end_ms, line.end_ms);
      } else {
        merged.push({ ...line });
      }
    }
  }
  return merged;
}

// ================================================================
// Lưu các dòng đã xử lý vào bảng transcripts (thay thế TOÀN BỘ dòng cũ của meeting)
// ================================================================

export async function saveProcessedTranscripts(
  meetingId: string,
  lines: ProcessedLine[],
  // forceNames=true (dùng cho re-diarize): đặt tên người nói ÁP ĐẶT theo lines, KỂ CẢ tên chung
  // chung ("Speaker N", "Diễn giả"). Mặc định false: bỏ qua placeholder để không đè tên thật.
  forceNames = false
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // 1. Bảo đảm speakers tồn tại (1 bộ / meeting, không versioning).
  const { data: existingSpeakers } = await supabase
    .from("speakers")
    .select("id, speaker_tag, display_name")
    .eq("meeting_id", meetingId);

  const tagToId: Record<string, string> = {};
  (existingSpeakers || []).forEach((s: any) => { tagToId[s.speaker_tag] = s.id; });

  // Tên tốt nhất cho mỗi tag. Mặc định bỏ qua placeholder "Speaker N"/"Unknown"; khi forceNames
  // thì nhận mọi tên (để re-diarize kiểu "đánh số"/"độc thoại" hiển thị đúng nhãn mong muốn).
  const tagBestName: Record<string, Record<string, number>> = {};
  for (const l of lines) {
    const name = (l.speaker_name || "").trim();
    const isPlaceholder = /^Speaker\s+\d+$/i.test(name) || name === "Unknown Speaker";
    if (name && (forceNames || !isPlaceholder)) {
      (tagBestName[l.speaker_tag] ||= {})[name] = (tagBestName[l.speaker_tag]?.[name] || 0) + 1;
    }
  }
  const bestNameOf = (tag: string): string | null => {
    const m = tagBestName[tag];
    if (!m) return null;
    return Object.keys(m).sort((a, b) => m[b] - m[a])[0] || null;
  };

  const uniqueTags = Array.from(new Set(lines.map((l) => l.speaker_tag)));
  for (const tag of uniqueTags) {
    const best = bestNameOf(tag);
    if (!tagToId[tag]) {
      const { data: ns } = await supabase
        .from("speakers")
        .insert({
          meeting_id: meetingId,
          speaker_tag: tag,
          display_name: best || tag.replace("speaker_", "Speaker "),
          color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
        })
        .select("id")
        .single();
      if (ns) tagToId[tag] = ns.id;
    } else if (best) {
      const cur = (existingSpeakers || []).find((s: any) => s.speaker_tag === tag);
      if (cur && cur.display_name !== best) {
        await supabase.from("speakers").update({ display_name: best }).eq("id", tagToId[tag]);
      }
    }
  }

  // 2. Thay thế toàn bộ dòng processed cũ.
  await supabase.from("transcripts").delete().eq("meeting_id", meetingId);

  const rows = lines.map((l) => ({
    meeting_id: meetingId,
    speaker_id: tagToId[l.speaker_tag] || null,
    original_text: l.original_text,
    translated_text: l.translated_text || null,
    speaker_tag: l.speaker_tag,
    speaker_name: l.speaker_name,
    start_ms: l.start_ms,
    end_ms: l.end_ms,
    confidence: l.confidence,
  }));

  for (let i = 0; i < rows.length; i += 100) {
    await supabase.from("transcripts").insert(rows.slice(i, i + 100));
  }
}

// ================================================================
// Orchestrator — xử lý toàn bộ transcript của 1 meeting
// ================================================================

function getChunkHash(words: DgWord[], chunk: WordChunk, config: PipelineConfig, mode: string | null | undefined): string {
  const chunkWords = words.slice(chunk.startIdx, chunk.endIdx).map(w => w.w).join(" ");
  const glossaryStr = JSON.stringify(config.glossary || []);
  const speakersStr = JSON.stringify(config.speakers || []);
  const raw = `${chunk.contextText}::${chunkWords}::${config.sourceLanguage}::${config.targetLanguage}::${mode || ""}::${glossaryStr}::${speakersStr}`;
  return createHash("sha256").update(raw).digest("hex");
}

export async function processMeetingTranscript(
  meetingId: string,
  config: PipelineConfig,
  shouldCancel?: () => Promise<boolean>,
  mode?: string | null
): Promise<ProcessedLine[]> {
  const supabase = await createServerSupabaseClient();

  const { data: meeting } = await supabase
    .from("meetings")
    .select("raw_deepgram_result")
    .eq("id", meetingId)
    .single();

  const words = extractWords(meeting?.raw_deepgram_result);
  if (words.length === 0) return [];

  const chunks = buildChunks(words);

  if (shouldCancel && (await shouldCancel())) throw new Error("CANCELLED");

  // Read existing cache rows from database
  const { data: cachedRows } = await supabase
    .from("pipeline_cache")
    .select("chunk_index, words_hash, result")
    .eq("meeting_id", meetingId);
  const cacheMap = new Map<number, { hash: string; result: ProcessedLine[] }>();
  (cachedRows || []).forEach((row: any) => {
    cacheMap.set(row.chunk_index, { hash: row.words_hash, result: row.result });
  });

  const chunkResults = await mapWithConcurrency(chunks, CONCURRENCY, async (chunk, idx) => {
    if (shouldCancel && (await shouldCancel())) throw new Error("CANCELLED");

    const currentHash = getChunkHash(words, chunk, config, mode);
    const cached = cacheMap.get(idx);
    if (cached && cached.hash === currentHash) {
      console.log(`[processMeetingTranscript] Cache HIT for chunk ${idx}/${chunks.length}`);
      return cached.result;
    }

    console.log(`[processMeetingTranscript] Cache MISS for chunk ${idx}/${chunks.length} - processing with AI`);
    const result = await processChunk(words, chunk, config, mode);

    // Save to cache
    await supabase.from("pipeline_cache").upsert({
      meeting_id: meetingId,
      chunk_index: idx,
      words_hash: currentHash,
      result: result,
      created_at: new Date().toISOString()
    }, { onConflict: "meeting_id,chunk_index" });

    return result;
  });

  if (shouldCancel && (await shouldCancel())) throw new Error("CANCELLED");

  const lines = stitch(chunkResults);
  await saveProcessedTranscripts(meetingId, lines);
  return lines;
}

// ================================================================
// RE-DIARIZE NHẸ — chỉ gán lại NGƯỜI NÓI trên các dòng ĐÃ CÓ.
// KHÔNG bóc băng lại, KHÔNG sửa chính tả, KHÔNG dịch lại (giữ nguyên text + translated_text).
// Rẻ hơn nhiều so với chạy lại `process`. Dùng cho dropdown "Phân vai" ở tab Hội thoại.
// ================================================================

const REASSIGN_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    speaker_mappings: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          speaker_tag: { type: SchemaType.STRING },
          speaker_name: { type: SchemaType.STRING },
          merge_into_tag: { type: SchemaType.STRING },
        },
        required: ["speaker_tag", "speaker_name", "merge_into_tag"],
      },
    },
  },
  required: ["speaker_mappings"],
};

interface SpeakerMapping {
  speaker_tag: string;
  speaker_name: string;
  merge_into_tag: string;
}

function reassignModeInstruction(mode: string | null | undefined): string {
  switch (mode) {
    case "by_name":
      return `Suy ra TÊN THẬT của mỗi người nói từ nội dung hội thoại mẫu (xưng hô, giới thiệu, gọi tên) và gán vào speaker_name. Cùng một người phải có cùng merge_into_tag. Nếu không tìm được tên thật -> giữ nguyên hoặc điền "Speaker N".`;
    case "by_role":
      return `Gán speaker_name theo VAI TRÒ suy từ nội dung mẫu (Quản lý, Nhân viên, Khách hàng, Phỏng vấn viên, Ứng viên...). Cùng một người/vai trò phải có cùng merge_into_tag. Nếu không rõ -> gán "Người tham gia N".`;
    case "merge_speakers":
      return `GỘP các speaker có thể là CÙNG một người (do máy tách nhầm): gán cho họ cùng merge_into_tag (ví dụ cả speaker_1 và speaker_2 đều gộp vào speaker_1). Phân tích văn phong, chủ đề, đại từ xưng hô để quyết định.`;
    default:
      return `Gán người nói dựa trên danh sách đã đăng ký + ngữ cảnh hội thoại mẫu. Cùng một người phải có cùng merge_into_tag.`;
  }
}

// Gọi AI 1 lần: phân tích mẫu hội thoại của các speaker_tag và trả về Metadata Mapping (tên/gộp)
async function aiReassignSpeakers(
  lines: ProcessedLine[],
  config: PipelineConfig,
  mode: string | null | undefined
): Promise<SpeakerMapping[]> {
  // Gom các mẫu hội thoại của từng speaker_tag
  const speakerSamples: Record<string, string[]> = {};
  for (const l of lines) {
    if (!l.speaker_tag) continue;
    if (!speakerSamples[l.speaker_tag]) {
      speakerSamples[l.speaker_tag] = [];
    }
    // Lấy tối đa 12 dòng hội thoại tiêu biểu (bỏ dòng quá ngắn)
    if (speakerSamples[l.speaker_tag].length < 12 && l.original_text.trim().length > 10) {
      speakerSamples[l.speaker_tag].push(l.original_text.trim());
    }
  }

  // Dự phòng nếu có speaker chỉ nói các câu cực ngắn
  for (const l of lines) {
    if (!l.speaker_tag) continue;
    if (speakerSamples[l.speaker_tag].length === 0) {
      speakerSamples[l.speaker_tag].push(l.original_text.trim());
    }
  }

  const input = Object.entries(speakerSamples).map(([tag, texts]) => ({
    speaker_tag: tag,
    dialogue_samples: texts,
  }));

  const speakersStr = config.speakers.length > 0
    ? JSON.stringify(config.speakers.map((s) => ({ speaker_tag: s.speaker_tag, display_name: s.display_name })))
    : "(chưa đăng ký)";

  const prompt = `
Bạn là chuyên gia phân tách người nói (diarization).
Dưới đây là MẪU HỘI THOẠI (dialogue samples) của từng người nói (speaker_tag).
Nhiệm vụ của bạn là phân tích nội dung mẫu của mỗi người nói để gán tên thật hoặc vai trò và quyết định xem có gộp speaker nào hay không.

YÊU CẦU: ${reassignModeInstruction(mode)}

NGÔN NGỮ: ${getSourceLangLabel(config.sourceLanguage)}
NGƯỜI NÓI ĐÃ ĐĂNG KÝ: ${speakersStr}

DỮ LIỆU MẪU (JSON):
${JSON.stringify(input)}

Trả về "speaker_mappings" cho TẤT CẢ các speaker_tag nhận được ở dữ liệu đầu vào.
Với mỗi đối tượng trong speaker_mappings:
- speaker_tag: tag hiện tại (ví dụ: "speaker_1")
- speaker_name: Tên thật suy luận được, hoặc vai trò suy luận được, hoặc nhãn thích hợp.
- merge_into_tag: Nếu phát hiện speaker_tag này thực chất là cùng một người với một speaker_tag khác, hãy điền tag đích ở đây (ví dụ: "speaker_1"). Nếu không gộp, hãy điền BẰNG CHÍNH "speaker_tag" của đối tượng đó.`;

  const result = await callGemini<{ speaker_mappings: SpeakerMapping[] }>(
    prompt,
    process.env.AI_FAST_MODEL || AI_MODEL,
    { temperature: 0, responseSchema: REASSIGN_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS }
  );

  return Array.isArray(result?.speaker_mappings) ? result.speaker_mappings : [];
}

// Gộp các dòng liên tiếp CÙNG speaker_tag
function mergeAdjacentSameSpeaker(lines: ProcessedLine[]): ProcessedLine[] {
  const out: ProcessedLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker_tag === l.speaker_tag) {
      prev.original_text = `${prev.original_text} ${l.original_text}`.trim();
      prev.translated_text = `${prev.translated_text} ${l.translated_text}`.trim();
      prev.end_ms = Math.max(prev.end_ms, l.end_ms);
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

export async function reDiarizeMeeting(
  meetingId: string,
  config: PipelineConfig,
  mode: string | null | undefined
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  // Try to restore original lines from pipeline_cache to preserve original sentence segments & speaker_tags
  const { data: cachedRows } = await supabase
    .from("pipeline_cache")
    .select("chunk_index, result")
    .eq("meeting_id", meetingId)
    .order("chunk_index", { ascending: true });

  let lines: ProcessedLine[] = [];

  if (cachedRows && cachedRows.length > 0) {
    const chunkResults = cachedRows.map((r: any) => r.result as ProcessedLine[]);
    lines = stitch(chunkResults);
    console.log(`[reDiarizeMeeting] Restored ${lines.length} original lines from pipeline_cache`);
  } else {
    // Fallback if no cache exists (e.g. legacy meetings)
    const { data: rows } = await supabase
      .from("transcripts")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("start_ms", { ascending: true });
    if (!rows || rows.length === 0) return;

    lines = rows.map((r: any) => ({
      original_text: r.original_text || "",
      translated_text: r.translated_text || "",
      speaker_tag: r.speaker_tag || "speaker_1",
      speaker_name: r.speaker_name || "",
      start_ms: r.start_ms || 0,
      end_ms: r.end_ms || 0,
      confidence: r.confidence ?? 1.0,
    }));
    console.log(`[reDiarizeMeeting] Loaded ${lines.length} lines from transcripts (no cache found)`);
  }

  if (mode === "numbered") {
    // Pure tag rename - no AI
    lines = lines.map((l) => ({ ...l, speaker_name: l.speaker_tag.replace("speaker_", "Speaker ") }));
  } else if (mode === "single_speaker_split") {
    // Monologue - map all to speaker_1, keep original lines (no AI, no merge)
    lines = lines.map((l) => ({ ...l, speaker_tag: "speaker_1", speaker_name: "Diễn giả" }));
  } else if (mode === null || mode === undefined || mode === "default") {
    // Reset to default registered names or tags
    const registeredSpeakers = config.speakers || [];
    const tagToName: Record<string, string> = {};
    registeredSpeakers.forEach((s) => {
      tagToName[s.speaker_tag] = s.display_name;
    });

    lines = lines.map((l) => ({
      ...l,
      speaker_name: tagToName[l.speaker_tag] || l.speaker_tag.replace("speaker_", "Speaker "),
    }));
  } else {
    // by_name / by_role / merge_speakers -> reassign using Mapping Metadata
    const mappings = await aiReassignSpeakers(lines, config, mode);

    const mergeMap: Record<string, string> = {};
    const nameMap: Record<string, string> = {};
    for (const m of mappings) {
      if (m.speaker_tag) {
        nameMap[m.speaker_tag] = m.speaker_name || "";
        if (m.merge_into_tag && m.merge_into_tag !== m.speaker_tag) {
          mergeMap[m.speaker_tag] = m.merge_into_tag;
        }
      }
    }

    const resolveTag = (tag: string): string => {
      let current = tag;
      const visited = new Set<string>();
      while (mergeMap[current] && !visited.has(current)) {
        visited.add(current);
        current = mergeMap[current];
      }
      return current;
    };

    lines = lines.map((l) => {
      const finalTag = resolveTag(l.speaker_tag);
      const name = nameMap[finalTag] || nameMap[l.speaker_tag] || l.speaker_name;
      return {
        ...l,
        speaker_tag: finalTag,
        speaker_name: name.trim(),
      };
    });

    lines = mergeAdjacentSameSpeaker(lines);
  }

  // Save the lines, overwrite the transcripts
  await saveProcessedTranscripts(meetingId, lines, true);
}
