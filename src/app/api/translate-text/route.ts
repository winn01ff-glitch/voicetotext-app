import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { text, sourceLang, targetLang } = body;

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const translationModelName = process.env.AI_TRANSLATION_MODEL || "gemini-3.1-flash-lite";
    const model = genAI.getGenerativeModel({
      model: translationModelName,
    });

    const prompt = `
You are a professional and natural translator.
Task: Translate the following text from "${sourceLang || "Japanese"}" to "${targetLang || "Vietnamese"}".
Requirements:
- Translate faithfully and naturally.
- Keep context-appropriate tone and style.
- Only return the translated text. Do not add explanations, notes, or markdown.
- If the original text is already in the target language, return the original text exactly.

Text to translate:
"${text}"
`;

    const result = await model.generateContent(prompt);
    const translatedText = result.response.text().trim().replace(/^"(.*)"$/, '$1'); // Clean wrapping quotes if Gemini adds any

    return NextResponse.json({ translatedText });
  } catch (error: any) {
    console.error("Translation API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
