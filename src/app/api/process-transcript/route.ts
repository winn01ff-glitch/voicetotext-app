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

    // 4. Fetch the last 3 transcripts to use as context for boundary alignment and merging
    const { data: recentTxs } = await supabase
      .from("transcripts")
      .select("id, original_text, corrected_text, translated_text, start_ms, end_ms, speaker_id, speakers(speaker_tag, display_name)")
      .eq("meeting_id", meeting_id)
      .order("start_ms", { ascending: false })
      .limit(3);
      
    const history = (recentTxs || []).reverse();
    const historyContext = history.map((tx: any, idx: number) => ({
      index: idx + 1,
      id: tx.id,
      text: tx.original_text,
      speaker_tag: tx.speakers?.speaker_tag || "unknown",
      speaker_name: tx.speakers?.display_name || "Unknown",
      end_ms: tx.end_ms
    }));

    const targetLang = meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;

    const timeGap = history.length > 0 ? (start_ms - history[history.length - 1].end_ms) : 0;

    const systemPrompt = `
You are an expert dialogue editor and translator. Your job is to process a new raw speech transcript segment in a live conversation, correct any transcription or speaker diarization boundary errors using the recent conversation history, split it into dialogue turns if multiple speakers spoke, and translate the text.

CONVERSATION HISTORY (Chronological order):
${JSON.stringify(historyContext)}

NEW SEGMENT TO PROCESS:
- Raw Speaker Tag: "${speaker_tag}" (Temporary Name: "${resolvedSpeaker?.display_name || "Unknown"}")
- Raw Text: "${original_text}"
- Time Gap since last segment: ${history.length > 0 ? timeGap : "N/A"} ms

CONTEXT OF THE MEETING:
${context || "General business/technical discussion"}

GLOSSARY (Must apply if matching words are found):
${JSON.stringify(glossaryList || [])}

TASK:
1. DIARIZATION/BOUNDARY CORRECTION:
   Compare the last sentence in the history and the new raw text.
   Identify if the new text starts with a word, syllable, or particle (e.g. Japanese question particle "か", "ね", "です", or Vietnamese endings "không", "à", "nhỉ") that actually belongs to the end of the previous speaker's sentence.
   - If yes: Move it back to the end of the previous speaker's sentence. Record this in "corrected_previous_text" and translate it.

2. SPLITTING INTO BLOCKS:
   Analyze the new raw text.
   - If the new raw text contains speech from multiple speakers (e.g. Person A asks a question and Person B answers immediately in the same text block), you MUST split the new raw text into separate chronological dialogue turns in the "blocks" array.
   - If the new raw text is spoken entirely by one speaker, "blocks" should contain exactly one item.
   - Assign the correct "speaker_tag" (e.g. speaker_0 or speaker_1) to each block.

3. TRANSLATION:
   - Translate each block's text into "${targetLang}" contextually and naturally (store in "translated_text").

OUTPUT FORMAT:
Return a valid JSON object ONLY. Do not write any markdown code fences, do not write explanations.
JSON format must be exactly:
{
  "corrected_previous_text": "updated previous original text (only if trailing words of previous speaker were moved back, otherwise empty string)",
  "corrected_previous_translation": "translation of corrected_previous_text (only if corrected_previous_text is updated, otherwise empty string)",
  "blocks": [
    {
      "speaker_tag": "the correct speaker tag (e.g. speaker_0 or speaker_1)",
      "text": "cleaned original text for this dialogue turn",
      "translated_text": "translation of this turn into ${targetLang}"
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
