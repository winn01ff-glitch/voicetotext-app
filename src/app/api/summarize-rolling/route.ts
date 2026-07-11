import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiClient, runWithGeminiClient } from "@/lib/ai/geminiClient";

// Cheap, cumulative summary of "who's who / topics" for a live meeting so far —
// injected into process-transcript-batch as context beyond its fixed 30-line window.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { previous_summary, new_lines } = body;

    if (!Array.isArray(new_lines) || new_lines.length === 0) {
      return NextResponse.json({ error: "Missing new_lines" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
    const generationConfig = { temperature: 0.2 };

    const prompt = `
You maintain a running summary of an in-progress meeting for another AI that assigns speaker roles.
Keep it SHORT (max 4 sentences), factual, and focused on: who each speaker is (name/role if known), and the main topics discussed so far.

PREVIOUS SUMMARY:
${previous_summary || "(none — this is the first update)"}

NEW LINES SINCE LAST SUMMARY:
${JSON.stringify(new_lines)}

Return ONLY the updated summary text. No markdown, no labels, no explanations.
`;

    const summary = await runWithGeminiClient(async (client) => {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig,
      });
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    });

    return NextResponse.json({ summary });
  } catch (error: any) {
    console.error("Summarize rolling error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
