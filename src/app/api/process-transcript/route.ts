import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, speaker_tag, original_text, start_ms, end_ms, confidence, target_language, diarize_enabled } = body;

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

    // 2.5. Fetch all registered speakers for this meeting to map tags correctly
    const { data: allSpeakers } = await supabase
      .from("speakers")
      .select("speaker_tag, display_name, language_code")
      .eq("meeting_id", meeting_id);

    // 3. Resolve Speaker ID
    let speakerId = null;
    let resolvedSpeaker = null;
    if (speaker_tag) {
      const { data: speaker } = await supabase
        .from("speakers")
        .select("*")
        .eq("meeting_id", meeting_id)
        .eq("speaker_tag", speaker_tag)
        .maybeSingle();

      if (speaker) {
        speakerId = speaker.id;
        resolvedSpeaker = speaker;
      } else {
        const { data: newSpeaker } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag,
            display_name: speaker_tag === "speaker_0" ? "Tôi" : speaker_tag.replace("speaker_", "Speaker "),
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select().single();
        if (newSpeaker) {
          speakerId = newSpeaker.id;
          resolvedSpeaker = newSpeaker;
        }
      }
    }

    // 4. Fetch the last 30 transcripts to use as context for boundary alignment and merging
    const { data: recentTxs } = await supabase
      .from("transcripts")
      .select("id, original_text, corrected_text, translated_text, start_ms, end_ms, speaker_id, confidence, speakers(speaker_tag, display_name)")
      .eq("meeting_id", meeting_id)
      .order("start_ms", { ascending: false })
      .limit(30);
      
    const history = (recentTxs || []).reverse();
    const historyContext = history.map((tx: any, idx: number) => ({
      index: idx + 1,
      id: tx.id,
      text: tx.original_text,
      speaker_tag: tx.speakers?.speaker_tag || "unknown",
      speaker_name: tx.speakers?.display_name || "Unknown",
      end_ms: tx.end_ms
    }));

    const targetLang = target_language || meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;
    const diarizeMode = diarize_enabled !== false;

    const timeGap = history.length > 0 ? (start_ms - history[history.length - 1].end_ms) : 0;

    // Language-specific instructions
    const sourceLangLabel: Record<string, string> = {
      ja: "Japanese (日本語)",
      en: "English",
      vi: "Vietnamese (Tiếng Việt)",
      auto: "Auto-detect (may be Japanese, English, Vietnamese, or mixed)",
    };

    const sourceLangInstruction: Record<string, string> = {
      ja: `The input speech is in JAPANESE. Expect Japanese text with possible kanji errors from ASR.
Speaker cues: Pronouns (私/僕/俺), register (です/ます vs だ/ね), particles (よ/ね/か), aizuchi (なるほど, うん, はい)`,
      en: `The input speech is in ENGLISH. Expect English text with possible homophones from ASR.
Speaker cues: Pronouns (I/you), question vs statement, formal vs casual, backchannels (yeah, okay, I see)`,
      vi: `The input speech is in VIETNAMESE. Expect Vietnamese text with possible diacritics errors from ASR.
Speaker cues: Pronouns (tôi/anh/chị/em), register (formal ạ vs casual ừ/nhé), backchannels (vâng, dạ, ừ)`,
      auto: `The input speech language is AUTO-DETECTED (Japanese, English, Vietnamese, or mixed). Apply all language-specific cues. Language switches signal speaker changes.`,
    };

    // Cold start note
    const coldStartNote = historyContext.length === 0
      ? `\n⚠️ COLD START: No conversation history yet. ${diarizeMode ? "Trust Deepgram speaker hints more heavily." : "Rely on linguistic structure. First speaker is likely speaker_1."}`
      : "";

    // Diarize mode instruction
    const diarizeInstruction = diarizeMode
      ? `The "speaker_tag" is a HINT from Deepgram audio analysis. VERIFY it against conversation history and correct if it contradicts the dialog logic.`
      : `Audio diarization is DISABLED. The speaker_tag "${speaker_tag}" is a default — ignore it. Detect speaker changes using dialog transitions, pronoun shifts, and register changes.`;

    const systemPrompt = `
You are an expert dialogue editor, speaker classifier, and translator for live meeting transcription.

Source Language: ${sourceLangLabel[sourceLang] || sourceLangLabel["auto"]}
Target Language: ${targetLang}
${sourceLangInstruction[sourceLang] || sourceLangInstruction["auto"]}

Task:
1. Split the raw segment into natural turns by speaker change. Never merge different speakers.
2. ${diarizeInstruction}
3. Map each turn to the correct "speaker_tag" from the REGISTERED SPEAKERS.
4. Keep the original text identical to the raw text, but you MAY correct obvious spelling/typos/wrong kanji in "corrected_text".
   CRITICAL: Do NOT add, remove, or paraphrase any words. Do NOT add vocabulary that was never spoken. Preserve all filler words.
5. Translate each turn into "${targetLang}".
   If the original text is already in "${targetLang}", set translated_text = original_text.

REGISTERED SPEAKERS:
${JSON.stringify(allSpeakers || [])}

CONVERSATION HISTORY (Last ${historyContext.length} lines):
${historyContext.length > 0 ? JSON.stringify(historyContext) : "(empty — first segment)"}
${coldStartNote}

MEETING CONTEXT: ${context || "General discussion"}

GLOSSARY:
${JSON.stringify(glossaryList || [])}

INPUT RAW SEGMENT TO PROCESS:
- Raw Speaker Tag: "${speaker_tag}" (Name: "${resolvedSpeaker?.display_name || "Unknown"}")
- Raw Text: "${original_text}"

Return VALID JSON ONLY. No markdown, no explanation.

{
  "corrected_previous_text": "updated previous original text (only if trailing words of previous speaker were moved back, otherwise empty string)",
  "corrected_previous_translation": "translation of corrected_previous_text (only if corrected_previous_text is updated, otherwise empty string)",
  "blocks": [
    {
      "speaker_tag": "correct speaker tag (MUST exactly match registered tags)",
      "raw_text": "original raw transcript",
      "corrected_text": "corrected text (ONLY fix obvious typos, DO NOT rewrite)",
      "translated_text": "translated text into ${targetLang}"
    }
  ]
}
`;

    // 5. Setup Gemini Client & Call API
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      generationConfig: { responseMimeType: "application/json" }
    });

    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (err) {
      console.warn(`Model ${modelName} failed, falling back to gemini-3.1-flash-lite:`, err);
      const fallbackModel = genAI.getGenerativeModel({ 
        model: "gemini-3.1-flash-lite",
        generationConfig: { responseMimeType: "application/json" }
      });
      result = await fallbackModel.generateContent(systemPrompt);
    }

    const responseText = result.response.text().trim();
    const aiResponse = JSON.parse(responseText);

    const correctedPrevText = aiResponse.corrected_previous_text;
    const correctedPrevTranslation = aiResponse.corrected_previous_translation;
    const aiBlocks = aiResponse.blocks || [];
    const finalActionItems: any[] = [];

    const lastTx = history.length > 0 ? history[history.length - 1] : null;

    // 1. Correct previous block if requested
    if (correctedPrevText && lastTx) {
      await supabase
        .from("transcripts")
        .update({
          original_text: correctedPrevText,
          corrected_text: correctedPrevText,
          translated_text: correctedPrevTranslation || lastTx.translated_text,
        })
        .eq("id", lastTx.id);
    }

    const resolvedBlocks: any[] = [];
    let isFirstBlockMerged = false;
    let mergedId = null;

    for (let i = 0; i < aiBlocks.length; i++) {
      const block = aiBlocks[i];
      block.text = block.corrected_text || block.raw_text || block.text || "";
      const blockSpeakerTag = block.speaker_tag || speaker_tag;
      
      // Resolve speaker ID
      let blockSpeakerId = speakerId;
      let blockResolvedSpeaker = resolvedSpeaker;
      if (blockSpeakerTag && blockSpeakerTag !== speaker_tag) {
        const { data: spObj } = await supabase
          .from("speakers")
          .select("*")
          .eq("meeting_id", meeting_id)
          .eq("speaker_tag", blockSpeakerTag)
          .maybeSingle();
        if (spObj) {
          blockSpeakerId = spObj.id;
          blockResolvedSpeaker = spObj;
        }
      }

      // Check if the FIRST block should be merged with the lastTx in the database
      if (i === 0 && !correctedPrevText && lastTx && lastTx.speaker_id === blockSpeakerId && timeGap < 30000) {
        // Merge!
        const isJapanese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/.test(lastTx.original_text + block.text);
        const joinChar = isJapanese ? "" : " ";
        const mergedText = (lastTx.original_text + joinChar + block.text).trim();

        await supabase
          .from("transcripts")
          .update({
            original_text: mergedText,
            corrected_text: mergedText,
            translated_text: block.translated_text,
            end_ms: end_ms,
            confidence: (confidence + (lastTx.confidence || 1.0)) / 2,
          })
          .eq("id", lastTx.id);

        resolvedBlocks.push({
          id: lastTx.id,
          text: mergedText,
          correctedText: mergedText,
          translatedText: block.translated_text,
          speakerTag: blockSpeakerTag,
          speakerName: blockResolvedSpeaker?.display_name || (blockSpeakerTag === "speaker_0" ? "Tôi" : blockSpeakerTag.replace("speaker_", "Speaker ")),
        });

        isFirstBlockMerged = true;
        mergedId = lastTx.id;
      } else {
        // Insert new Transcript
        const startMsVal = i === 0 ? (start_ms || 0) : (lastTx ? lastTx.end_ms + 100 : start_ms);
        const endMsVal = i === aiBlocks.length - 1 ? (end_ms || 0) : (start_ms + Math.round((end_ms - start_ms) / aiBlocks.length) * (i + 1));
        
        const { data: insertedTx } = await supabase
          .from("transcripts")
          .insert({
            meeting_id,
            speaker_id: blockSpeakerId,
            original_text: block.text,
            corrected_text: block.text,
            translated_text: block.translated_text,
            translation_language: targetLang,
            translation_provider: "Gemini",
            start_ms: startMsVal,
            end_ms: endMsVal,
            confidence: confidence || 1.0,
          })
          .select()
          .single();

        if (insertedTx) {
          resolvedBlocks.push({
            id: insertedTx.id,
            text: block.text,
            correctedText: block.text,
            translatedText: block.translated_text,
            speakerTag: blockSpeakerTag,
            speakerName: blockResolvedSpeaker?.display_name || (blockSpeakerTag === "speaker_0" ? "Tôi" : blockSpeakerTag.replace("speaker_", "Speaker ")),
          });
        }
      }
    }

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
      blocks: resolvedBlocks,
      merged: isFirstBlockMerged,
      merged_id: mergedId,
      corrected_previous_id: correctedPrevText ? lastTx?.id : null,
      corrected_previous_text: correctedPrevText,
      corrected_previous_translation: correctedPrevTranslation,
    });
  } catch (error) {
    console.error("Process transcript error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
