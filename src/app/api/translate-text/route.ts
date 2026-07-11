import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiClient, runWithGeminiClient } from "@/lib/ai/geminiClient";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { text, texts, sections, sourceLang, targetLang } = body;

    if (!text && (!texts || !Array.isArray(texts)) && !sections) {
      return NextResponse.json({ error: "Missing text, texts array, or sections object" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const translationModelName = "gemini-3.1-flash-lite"; // Force gemini-3.1-flash-lite as requested

    if (sections) {
      const prompt = `
You are a professional and natural translator.
Task: Translate the following JSON object containing meeting summary sections ("summary", "decisions", "action_items") from "${sourceLang || "auto"}" to "${targetLang || "Vietnamese"}".

Requirements:
- Translate faithfully and naturally. Keep the tone appropriate.
- Respond ONLY with a valid JSON object matching the exact structure and keys of the input.
- Do not add explanations, notes, or markdown formatting (like \`\`\`json). Only return raw JSON.
- If any string or text is already in the target language, keep it unchanged.

JSON to translate:
${JSON.stringify(sections)}
`;

      const rawText = await runWithGeminiClient(async (client) => {
        const model = client.getGenerativeModel({ model: translationModelName });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
      });

      let rawResponse = rawText;
      // Strip markdown code block if present
      if (rawResponse.startsWith("```")) {
        rawResponse = rawResponse.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
      }
      try {
        const parsed = JSON.parse(rawResponse);
        return NextResponse.json({ translatedSections: parsed });
      } catch (e) {
        console.error("Failed to parse batch sections translation response:", rawResponse, e);
        // Fallback: return original sections
        return NextResponse.json({ translatedSections: sections });
      }
    }

    if (texts && Array.isArray(texts)) {
      if (texts.length === 0) {
        return NextResponse.json({ translatedTexts: [] });
      }

      // If there are too many texts, we can chunk them (e.g. 50 lines per chunk) to avoid hitting token/output limits
      const chunks = [];
      const chunkSize = 50;
      for (let i = 0; i < texts.length; i += chunkSize) {
        chunks.push(texts.slice(i, i + chunkSize));
      }

      const translatedTexts: string[] = [];
      for (const chunk of chunks) {
        const prompt = `
You are a professional and natural translator.
Task: Translate the following JSON array of strings from "${sourceLang || "auto"}" to "${targetLang || "Vietnamese"}".
Requirements:
- Respond ONLY with a valid JSON array of strings representing the translations.
- Keep the exact same array length, keys, and order as the input.
- Do not add explanations, notes, or markdown formatting (like \`\`\`json). Only return raw JSON array.
- If a string is already in the target language, keep it unchanged.

JSON to translate:
${JSON.stringify(chunk)}
`;

        const rawText = await runWithGeminiClient(async (client) => {
          const model = client.getGenerativeModel({ model: translationModelName });
          const result = await model.generateContent(prompt);
          return result.response.text().trim();
        });

        let rawResponse = rawText;
        // Strip markdown code block if present
        if (rawResponse.startsWith("```")) {
          rawResponse = rawResponse.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
        }
        try {
          const parsed = JSON.parse(rawResponse);
          if (Array.isArray(parsed)) {
            translatedTexts.push(...parsed);
          } else {
            throw new Error("Response is not an array");
          }
        } catch (e) {
          console.error("Failed to parse batch translation response:", rawResponse, e);
          // Fallback: if JSON parse fails, use original texts
          translatedTexts.push(...chunk);
        }
      }

      return NextResponse.json({ translatedTexts });
    } else {
      const prompt = `
You are a professional and natural translator.
Task: Translate the following text from "${sourceLang || "auto"}" to "${targetLang || "Vietnamese"}".
Requirements:
- Translate faithfully and naturally.
- Keep context-appropriate tone and style.
- Only return the translated text. Do not add explanations, notes, or markdown.
- If the original text is already in the target language, return the original text exactly.

Text to translate:
"${text}"
`;

      const translatedText = await runWithGeminiClient(async (client) => {
        const model = client.getGenerativeModel({ model: translationModelName });
        const result = await model.generateContent(prompt);
        return result.response.text().trim().replace(/^"(.*)"$/, '$1');
      });

      return NextResponse.json({ translatedText });
    }
  } catch (error: any) {
    console.error("Translation API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
