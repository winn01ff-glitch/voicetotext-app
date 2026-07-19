import { NextResponse } from "next/server";
import { runWithGeminiClient } from "@/lib/ai/geminiClient";

// ================================================================
// Dịch NHANH cho màn hình live — KHÔNG phân vai.
// Một call flash-lite: sửa lỗi ASR (chính tả/ngữ pháp do Deepgram nghe nhầm)
// + dịch. Phân vai chuẩn thuộc pipeline hậu kỳ; route này chỉ lo tốc độ hiển
// thị lúc đang họp.
//
// Nhận NHIỀU dòng một lần (`lines`) để tiết kiệm hạn mức free của Gemini —
// giới hạn thật là 500 request/ngày/project, không phải token. Gộp 4 câu giảm
// request ~4 lần VÀ giảm luôn token (prompt dùng chung thay vì lặp mỗi dòng).
// Vẫn nhận `text` đơn để tương thích ngược.
// ================================================================

const RETRIES = 1;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { text, lines, source_language, target_language, glossary } = body;

    const inputLines: string[] = Array.isArray(lines)
      ? lines.filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0)
      : typeof text === "string" && text.trim()
        ? [text]
        : [];

    if (inputLines.length === 0) {
      return NextResponse.json({ error: "Missing text/lines" }, { status: 400 });
    }

    // Mã 2 ký tự ("vi") bị flash-lite hiểu lỏng — đã gặp ca dịch ra tiếng Anh dù
    // đích là tiếng Việt. Dùng tên đầy đủ + ràng buộc cứng trong prompt.
    const LANG_NAMES: Record<string, string> = {
      vi: "Vietnamese", en: "English", ja: "Japanese", ko: "Korean",
      zh: "Chinese", fr: "French", de: "German", es: "Spanish",
      th: "Thai", id: "Indonesian", ru: "Russian",
    };
    const targetName = LANG_NAMES[String(target_language).toLowerCase()] || target_language || "Vietnamese";
    const sourceName = LANG_NAMES[String(source_language).toLowerCase()] || "auto-detect";

    const glossaryNote =
      Array.isArray(glossary) && glossary.length > 0
        ? `\nGlossary (use these exact translations when the term appears):\n${glossary
            .slice(0, 30)
            .map((g: any) => `- "${g.source}" → "${g.target}"`)
            .join("\n")}`
        : "";

    const prompt = `
You are a live-caption post-processor for meeting transcription.

Input is a numbered list of ${inputLines.length} consecutive line(s) of raw ASR (speech-to-text) output from the same meeting.
Source language: ${sourceName}
Target language: ${targetName}

For EACH line, do exactly two things:
1. "corrected": Fix ONLY obvious ASR errors — wrong homophones/kanji, garbled fragments, misplaced punctuation, spelling. Do NOT rephrase, do NOT add or remove words, do NOT change meaning. Keep filler words. If the line is already clean, return it unchanged. Keep it in the SOURCE language — never translate here.
2. "translated": Translate the corrected line into ${targetName}, natural and faithful.

The lines are consecutive, so you may use neighbouring lines as context to disambiguate — but NEVER merge, split, reorder or drop lines. Return exactly ${inputLines.length} result object(s), in the same order as the input.

CRITICAL: "translated" MUST be written in ${targetName} and nothing else. Never output English (or any other language) unless ${targetName} IS that language. Proper nouns and place names may keep their original spelling, but the sentence around them must be ${targetName}. If a line is already in ${targetName}, return it unchanged.
${glossaryNote}
Respond ONLY with raw JSON (no markdown fence), an array of exactly ${inputLines.length} object(s):
[{"corrected": "...", "translated": "..."}]

Lines:
${inputLines.map((l, i) => `${i + 1}. ${JSON.stringify(l)}`).join("\n")}
`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const raw = await runWithGeminiClient(async (client) => {
          const model = client.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
          const result = await model.generateContent(prompt);
          return result.response.text().trim();
        });

        let jsonText = raw;
        if (jsonText.startsWith("```")) {
          jsonText = jsonText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
        }
        const parsed = JSON.parse(jsonText);
        // Model có thể trả object đơn khi chỉ có 1 dòng — chấp nhận cả hai dạng.
        const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];

        // Lệch số phần tử = không thể ghép tin cậy theo vị trí → coi như hỏng và
        // retry. Ghép sai còn tệ hơn không dịch: dòng A nhận bản dịch của dòng B.
        if (arr.length !== inputLines.length) {
          throw new Error(`Kết quả trả về ${arr.length} phần tử, mong đợi ${inputLines.length}`);
        }

        const results = inputLines.map((line, i) => {
          const item = arr[i] || {};
          const corrected =
            typeof item.corrected === "string" && item.corrected.trim() ? item.corrected.trim() : line;
          const translated = typeof item.translated === "string" ? item.translated.trim() : "";
          return { corrected_text: corrected, translated_text: translated };
        });

        return NextResponse.json({
          results,
          // Tương thích ngược cho caller cũ gửi `text` đơn.
          corrected_text: results[0].corrected_text,
          translated_text: results[0].translated_text,
        });
      } catch (err) {
        lastError = err;
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400));
      }
    }

    console.error("[translate-line] failed:", lastError);
    // Fail-soft: trả nguyên văn để UI không kẹt ở trạng thái chờ.
    const fallback = inputLines.map((line) => ({ corrected_text: line, translated_text: "" }));
    return NextResponse.json({
      results: fallback,
      corrected_text: fallback[0].corrected_text,
      translated_text: "",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
