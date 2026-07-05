import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { originalText, translatedText, sourceLang, targetLang } = body;

    if (!originalText) {
      return NextResponse.json({ error: "Missing originalText" }, { status: 400 });
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

    // 1. Summarize original text (if it's long, otherwise just return it)
    let originalSummary = originalText;
    if (originalText.length > 30) {
      const originalPrompt = `
You are a helpful assistant.
Task: Summarize the following text briefly (in 1 or 2 sentences max) in its original language (${sourceLang || "auto"}).
- Return only the summary text. Do not add explanations or notes.
Text: "${originalText}"
`;
      const result = await model.generateContent(originalPrompt);
      originalSummary = result.response.text().trim();
    }

    // 2. Summarize translated text (if it's long, otherwise just return it)
    let translatedSummary = translatedText || "";
    if (translatedText && translatedText.length > 30) {
      const translatedPrompt = `
You are a helpful assistant.
Task: Summarize the following text briefly (in 1 or 2 sentences max) in Vietnamese.
- Return only the summary text. Do not add explanations or notes.
Text: "${translatedText}"
`;
      const result = await model.generateContent(translatedPrompt);
      translatedSummary = result.response.text().trim();
    }

    return NextResponse.json({ originalSummary, translatedSummary });
  } catch (error: any) {
    console.error("Summarize line error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
