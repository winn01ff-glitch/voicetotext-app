import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, speaker_tag, original_text, start_ms, end_ms, confidence } = body;

    if (!meeting_id || !original_text) {
      return NextResponse.json({ error: "Missing required fields (meeting_id, original_text)" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Fetch meeting configuration
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("target_language, source_language, meeting_context")
      .eq("id", meeting_id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // 2. Fetch glossary
    const { data: glossaryList } = await supabase
      .from("glossary")
      .select("source, target, source_language, target_language")
      .eq("meeting_id", meeting_id);

    // 3. Setup Gemini Client & Call API
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelName = process.env.AI_FAST_MODEL || "gemini-2.0-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const targetLang = meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;

    const systemPrompt = `
You are an expert, professional translator specializing in technical and business translations.
Translate the following speech transcript from its source language (around ${sourceLang}) to the target language (${targetLang}) contextually, smoothly, and professionally.

CONTEXT OF THE MEETING/CONVERSATION:
${context || "Construction site safety training, slinging work (玉掛け), and cranes (クレーン)"}

GLOSSARY (Must apply if matching words are found):
${JSON.stringify(glossaryList || [])}

TRANSLATION RULES:
1. Translate the text naturally and contextually into the target language. Do NOT translate word-for-word literally if it makes no sense or produces broken language.
2. If the input transcript contains speech-to-text transcription typos (e.g. homophones or misheard words in the source language), identify the correct intended words based on the context and translate the intended meaning. For example, in a construction/crane/slinging context:
   - "グレー" or "クレー" should be translated as "Cần cẩu / Crane".
   - "雨宿り" (amayadori - sheltering from rain) or similar misheard words should be translated contextually (e.g., joint work / slinging / helper).
   - "応急 けんばん" (emergency keyboard) or similar should be translated as "Tấm sắt lót đường / Steel plates".
   - "釣りクランプ" or "つりクランプ" should be translated as "Kẹp cẩu / Lifting clamp".
3. Keep the output strictly as the translated text only. Do not add any prefix, suffix, notes, explanations, or quotes.

Transcript to translate:
"${original_text}"
`;

    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (err) {
      console.warn(`Model ${modelName} failed, falling back to gemini-1.5-flash:`, err);
      const fallbackModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      result = await fallbackModel.generateContent(systemPrompt);
    }
    const finalTranslated = result.response.text().trim();
    const finalCorrected = original_text;
    const finalConfidence = confidence;
    const finalActionItems: any[] = [];

    // Resolve Speaker ID
    let speakerId = null;
    if (speaker_tag) {
      const { data: speaker } = await supabase
        .from("speakers")
        .select("id")
        .eq("meeting_id", meeting_id)
        .eq("speaker_tag", speaker_tag)
        .maybeSingle();

      if (speaker) {
        speakerId = speaker.id;
      } else {
        const { data: newSpeaker } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag,
            display_name: speaker_tag.replace("speaker_", "Speaker "),
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select().single();
        if (newSpeaker) speakerId = newSpeaker.id;
      }
    }

    // Insert Transcript
    await supabase.from("transcripts").insert({
      meeting_id,
      speaker_id: speakerId,
      original_text,
      corrected_text: finalCorrected,
      translated_text: finalTranslated,
      translation_language: targetLang,
      translation_provider: "Gemini",
      start_ms: start_ms || 0,
      end_ms: end_ms || 0,
      confidence: finalConfidence || 1.0,
    });

    // Insert Action Items
    if (finalActionItems.length > 0) {
      const itemsToInsert = finalActionItems.map((item: any) => ({
        meeting_id,
        description: item.description,
        owner: item.owner || null,
        deadline: !isNaN(new Date(item.deadline).getTime()) ? new Date(item.deadline).toISOString() : null,
        is_completed: false,
      }));
      await supabase.from("action_items").insert(itemsToInsert);
    }

    return NextResponse.json({
      corrected: finalCorrected,
      translated: finalTranslated
    });
  } catch (error) {
    console.error("Process transcript error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
