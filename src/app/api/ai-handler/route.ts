import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getGeminiClient, runWithGeminiClient } from "@/lib/ai/geminiClient";

// --- Helpers for process-transcript-batch ---
function collapseAdjacentDuplicates(text: string): string {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const uniqueLines = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
  const joined = uniqueLines.join("\n").trim();
  const compact = joined.replace(/\s+/g, "");
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(compact) && compact.length >= 8 && compact.length % 2 === 0) {
    const half = compact.length / 2;
    if (compact.slice(0, half) === compact.slice(half)) return compact.slice(0, half);
  }
  return joined;
}

function validateCorrectedText(input: string, candidate: string): string {
  const cleaned = collapseAdjacentDuplicates(candidate);
  const inputLength = input.replace(/\s+/g, "").length;
  const outputLength = cleaned.replace(/\s+/g, "").length;
  if (!cleaned || inputLength === 0) return input;
  if (outputLength > inputLength * 1.35 || outputLength < inputLength * 0.65) return input;
  return cleaned;
}

// --- Helpers for translate-text ---
const TRANSLATION_CONCURRENCY = 5;
const TRANSLATION_RETRIES = 2;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function withTranslationRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSLATION_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < TRANSLATION_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// --- Helper for translate-line ---
const RETRIES = 1;

// ============================================================================
// HANDLERS
// ============================================================================

async function handleProcessTranscript(body: any) {
  const { meeting_id, speaker_tag, original_text, start_ms, end_ms, confidence, target_language, diarize_enabled } = body;

  if (!meeting_id || !original_text) {
    return NextResponse.json({ error: "Missing required fields (meeting_id, original_text)" }, { status: 400 });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("target_language, source_language, meeting_context")
    .eq("id", meeting_id)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data: glossaryList } = await supabase
    .from("glossary")
    .select("source, target, source_language, target_language")
    .eq("meeting_id", meeting_id);

  const { data: allSpeakers } = await supabase
    .from("speakers")
    .select("speaker_tag, display_name, language_code")
    .eq("meeting_id", meeting_id);

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
          display_name: speaker_tag === "speaker_1" ? "Speaker 1" : speaker_tag.replace("speaker_", "Speaker "),
          color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
        })
        .select().single();
      if (newSpeaker) {
        speakerId = newSpeaker.id;
        resolvedSpeaker = newSpeaker;
      }
    }
  }

  const { data: recentTxs } = await supabase
    .from("transcripts")
    .select("id, original_text, corrected_text, translated_text, start_ms, end_ms, speaker_id, confidence, speakers(speaker_tag, display_name)")
    .eq("meeting_id", meeting_id)
    .order("start_ms", { ascending: false })
    .limit(20);
    
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

  const sourceLangLabel: Record<string, string> = {
    ja: "Japanese (日本語)",
    en: "English",
    vi: "Vietnamese (Tiếng Việt)",
    auto: "Auto-detect (may be Japanese, English, Vietnamese, or mixed)",
  };

  const sourceLangInstruction: Record<string, string> = {
    ja: `The input speech is in JAPANESE. Expect Japanese text with possible kanji errors from ASR.
Speaker cues: Pronouns (私/僕/俺), register (です/ます vs だ/ね), particles (よ/ね/か), aizuchi (なるほど, うん, hai)`,
    en: `The input speech is in ENGLISH. Expect English text with possible homophones from ASR.
Speaker cues: Pronouns (I/you), question vs statement, formal vs casual, backchannels (yeah, okay, I see)`,
    vi: `The input speech is in VIETNAMESE. Expect Vietnamese text with possible diacritics errors from ASR.
Speaker cues: Pronouns (tôi/anh/chị/em), register (formal ạ vs casual ừ/nhé), backchannels (vâng, dạ, ừ)`,
    auto: `The input speech language is AUTO-DETECTED (Japanese, English, Vietnamese, or mixed). Apply all language-specific cues. Language switches signal speaker changes.`,
  };

  const coldStartNote = historyContext.length === 0
    ? `\n⚠️ COLD START: No conversation history yet. ${diarizeMode ? "Trust Deepgram speaker hints more heavily." : "Rely on linguistic structure. First speaker is likely speaker_1."}`
    : "";

  const diarizeInstruction = diarizeMode
    ? `The "speaker_tag" is a HINT from Deepgram audio analysis. VERIFY it against conversation history and correct if it contradicts the dialog logic.`
    : `Audio diarization is DISABLED. The speaker_tag "${speaker_tag}" is a default — ignore it. Detect speaker changes using dialog transitions, pronoun shifts, and register changes.`;

  const systemInstructionText = `
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

Return VALID JSON ONLY. No markdown, no explanation.

Expected Output Format:
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

  const userContent = `
REGISTERED SPEAKERS:
${JSON.stringify(allSpeakers || [])}

CONVERSATION HISTORY (Last ${historyContext.length} lines):
${historyContext.length > 0 ? JSON.stringify(historyContext) : "(empty — first segment)"}
${coldStartNote}

MEETING CONTEXT: ${context || "General discussion"}

GLOSSARY:
${JSON.stringify(glossaryList || [])}

INPUT RAW SEGMENT TO PROCESS:
- Start Time: ${start_ms || 0} ms
- End Time: ${end_ms || 0} ms
- Time Gap since last turn: ${timeGap} ms
- Raw Speaker Tag: "${speaker_tag}" (Name: "${resolvedSpeaker?.display_name || "Unknown"}")
- Raw Text: "${original_text}"

Perform the task and return ONLY the JSON object matching the expected format.
`;

  const genAI = getGeminiClient();
  const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
  const generationConfig = { 
    responseMimeType: "application/json" as const,
    temperature: 0.3 
  };

  const model = genAI.getGenerativeModel({ 
    model: modelName,
    systemInstruction: systemInstructionText,
    generationConfig
  });

  let result;
  try {
    result = await model.generateContent(userContent);
  } catch (err) {
    console.warn(`Model ${modelName} failed, falling back to gemini-3.1-flash-lite:`, err);
    const fallbackModel = genAI.getGenerativeModel({ 
      model: "gemini-3.1-flash-lite",
      systemInstruction: systemInstructionText,
      generationConfig
    });
    result = await fallbackModel.generateContent(userContent);
  }

  const responseText = result.response.text().trim();
  const aiResponse = JSON.parse(responseText);

  const correctedPrevText = aiResponse.corrected_previous_text;
  const correctedPrevTranslation = aiResponse.corrected_previous_translation;
  const aiBlocks = aiResponse.blocks || [];
  const finalActionItems: any[] = [];

  const lastTx = history.length > 0 ? history[history.length - 1] : null;

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

    if (i === 0 && !correctedPrevText && lastTx && lastTx.speaker_id === blockSpeakerId && timeGap < 30000) {
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
        speakerName: blockResolvedSpeaker?.display_name || (blockSpeakerTag === "speaker_1" ? "Speaker 1" : blockSpeakerTag.replace("speaker_", "Speaker ")),
      });

      isFirstBlockMerged = true;
      mergedId = lastTx.id;
    } else {
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
          speakerName: blockResolvedSpeaker?.display_name || (blockSpeakerTag === "speaker_1" ? "Speaker 1" : blockSpeakerTag.replace("speaker_", "Speaker ")),
        });
      }
    }
  }

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
}

async function handleProcessTranscriptBatch(body: any) {
  const { meeting_id, drafts, history, last_transcript, target_language, diarize_enabled, rolling_summary } = body;

  if (!meeting_id || !drafts || !Array.isArray(drafts) || drafts.length === 0) {
    return NextResponse.json({ error: "Missing required fields (meeting_id, drafts)" }, { status: 400 });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("target_language, source_language, meeting_context")
    .eq("id", meeting_id)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data: glossaryList } = await supabase
    .from("glossary")
    .select("source, target, source_language, target_language")
    .eq("meeting_id", meeting_id);

  const { data: allSpeakers } = await supabase
    .from("speakers")
    .select("speaker_tag, display_name, language_code")
    .eq("meeting_id", meeting_id);

  const historyContext = history || [];

  const draftsContext = drafts.map((d: any, idx: number) => ({
    index: idx + 1,
    speaker_tag: d.speakerTag,
    speaker_name: d.speakerName,
    text: d.text
  }));
  const allowedSpeakerTags = Array.from(new Set([
    ...(allSpeakers || []).map((speaker: any) => speaker.speaker_tag),
    ...historyContext.map((line: any) => line.speaker_tag),
    ...draftsContext.map((draft: any) => draft.speaker_tag),
  ].filter((tag): tag is string => typeof tag === "string" && /^speaker_\d+$/.test(tag))));
  if (allowedSpeakerTags.length === 0) allowedSpeakerTags.push("speaker_1");
  const establishedSpeakerTags = Array.from(new Set([
    ...(allSpeakers || []).map((speaker: any) => speaker.speaker_tag),
    ...historyContext.map((line: any) => line.speaker_tag),
  ].filter((tag): tag is string => typeof tag === "string" && /^speaker_\d+$/.test(tag))));

  const targetLang = target_language || meeting.target_language;
  const sourceLang = meeting.source_language;
  const context = meeting.meeting_context;
  const diarizeMode = diarize_enabled !== false; 

  const sourceLangLabel: Record<string, string> = {
    ja: "Japanese (日本語)",
    en: "English",
    vi: "Vietnamese (Tiếng Việt)",
    auto: "Auto-detect (may be Japanese, English, Vietnamese, or mixed)",
  };

  const sourceLangInstruction: Record<string, string> = {
    ja: `The input speech is in JAPANESE. Expect Japanese text with possible kanji errors from ASR.
Speaker identification cues:
- Pronouns: 私 (watashi, formal), 僕 (boku, male casual), 俺 (ore, male rough)
- Register: です/ます (polite) vs だ/ね (casual)
- Sentence-final particles: よ, ね, か, わ, ぞ
- Honorifics: 〜さん, 〜先生, 〜様
- Aizuchi (listener responses): なるほど, うん, はい, そうですね, ええ, あー`,
    en: `The input speech is in ENGLISH. Expect English text with possible homophones or mishearings from ASR.
Speaker identification cues:
- Pronouns: I/me vs you, we vs they
- Question vs statement patterns
- Formal ("Could you please...") vs casual ("Hey, so...")
- Backchannels (listener responses): yeah, okay, I see, right, uh-huh, sure, got it`,
    vi: `The input speech is in VIETNAMESE. Expect Vietnamese text with possible diacritics errors from ASR.
Speaker identification cues:
- Pronouns: tôi/mình (I, neutral), anh/chị/em (gendered/age-based), ông/bà (elderly)
- Register: formal (thưa, kính, ạ) vs casual (ừ, ờ, nhé, nha)
- Sentence-final particles: ạ, nhé, nha, nhỉ, hả, à
- Backchannels (listener responses): vâng, dạ, ừ, thế à, đúng rồi, à ra vậy`,
    auto: `The input speech language is AUTO-DETECTED and may be Japanese, English, Vietnamese, or a mix.
Apply ALL language-specific cues:
- Japanese: Pronouns (私/僕/俺), register (です・ます vs だ・ね), aizuchi (なるほど, うん, はい)
- English: Pronouns (I/you), question patterns, backchannels (yeah, okay, I see)
- Vietnamese: Pronouns (tôi/anh/chị/em), particles (ạ/nhé/nha), backchannels (vâng, dạ, ừ)
- IMPORTANT: Track which speaker uses which language — a language switch is a strong speaker-change signal.`,
  };

  const coldStartNote = historyContext.length === 0
    ? `
⚠️ COLD START: There is NO conversation history yet. This is the very first segment of the meeting.
- ${diarizeMode
        ? "Use Deepgram tags as audio hints, not identities. Streaming diarization may temporarily emit speaker_3+ for one of the first two voices. Prefer the smallest speaker set supported by clear dialogue evidence; keep a third tag only when the text clearly shows a genuinely distinct third participant."
        : "Since there is no history AND no audio hints, rely entirely on linguistic structure within THIS segment. The first person speaking is most likely speaker_1 (the meeting organizer). Only split into multiple speakers if there are very clear dialogue transitions (Question→Answer, pronoun shifts, register changes) within the segment."
      }
- As more segments are processed, future calls will include conversation history for better accuracy.`
    : "";

  const diarizeInstruction = diarizeMode
    ? `SPEAKER VERIFICATION (Audio-hint assisted mode):
   - The "speaker_tag" in each raw segment is a HINT from Deepgram's audio waveform analysis.
   - VERIFY each hint against the CONVERSATION HISTORY:
     • Does the content logically follow from what this speaker said before?
     • Does the tone/register match this speaker's established pattern?
   - If the hint is correct → keep it. If it contradicts the conversation logic → correct it.
   - A newly appearing speaker_3+ is tentative diarization drift until supported by clear evidence of a distinct participant. Do not preserve it merely because Deepgram emitted the tag.
   - Deepgram word-level diarization has already split speaker changes before this request.
   - Assign exactly ONE speaker to each input segment; do not split a segment.`
    : `CONTEXTUAL SPEAKER DIARIZATION (100% Semantic-based):
   - Audio diarization is DISABLED. All input is tagged "speaker_1" by default — ignore this tag.
   - You MUST detect speaker changes using ONLY:
     • Dialogue transitions: Question → Answer, Statement → Response
     • Pronoun shifts (see language-specific cues above)
     • Register/tone changes
     • Language switches (if applicable)
   - Cross-reference with CONVERSATION HISTORY to match speech patterns to known speakers.
   - Assign exactly ONE speaker to each input segment; do not split a segment.`;

  const systemInstructionText = `
You are an expert dialogue editor, speaker classifier, and translator for live meeting transcription.

==================================================
LANGUAGE CONFIGURATION
==================================================
Source Language: ${sourceLangLabel[sourceLang] || sourceLangLabel["auto"]}
Target Language: ${targetLang}
${sourceLangInstruction[sourceLang] || sourceLangInstruction["auto"]}

==================================================
INSTRUCTIONS
==================================================

1. ${diarizeInstruction}

2. LISTENING RESPONSES / BACKCHANNELS:
   - Use them as semantic evidence only. Do NOT split them out of an input segment; audio word-level boundaries are authoritative.
   - Japanese: なるほど, うん, はい, そうですね, ええ, あー
   - English: yeah, okay, I see, right, uh-huh, sure, got it
   - Vietnamese: vâng, dạ, ừ, thế à, đúng rồi, à ra vậy

3. STRICT WORD PRESERVATION:
   - "original_text": ONLY fix obvious ASR errors (wrong kanji, garbled text, diacritics, spelling).
   - Do NOT add, remove, rephrase, or restructure any words.
   - Keep ALL filler words (えー, あの, umm, à, ờ, uh).
   - NEVER change one valid word into a different word.

4. SEGMENT ALIGNMENT:
   - Return exactly ONE output item for every input item, with the same "index".
   - Do not merge, split, reorder, omit, or duplicate input segments.
   - speaker_tag MUST be one of ALLOWED SPEAKER TAGS. Never invent a new tag.
   - Tags absent from ESTABLISHED SPEAKER TAGS may be transient Deepgram diarization drift. Prefer an established tag when dialogue history supports it; keep a new tag only with clear evidence of a genuinely new participant.
   - Clean extreme stuttering or word loops (5+ repetitions).

5. TRANSLATION:
   - Translate each turn into "${targetLang}" naturally and faithfully.
   - If original text is already in "${targetLang}", set translated_text = original_text exactly.

==================================================
OUTPUT FORMAT
==================================================
Return VALID JSON ONLY. No markdown, no explanations, no code fences.

{
  "cleaned_turns": [
    {
      "index": 1,
      "speaker_tag": "speaker_X",
      "original_text": "corrected source text",
      "translated_text": "translation into ${targetLang}"
    }
  ]
}

==================================================
IMPORTANT RULES
==================================================

Never hallucinate.
Never invent missing dialogue.
Never merge different speakers into one turn.
Never translate names.
Never remove fillers unless they are obvious ASR duplication.
Prefer preserving uncertain words over guessing.
The output must preserve the chronological order of the conversation.
Return exactly ${draftsContext.length} cleaned_turns, matching input indices 1..${draftsContext.length}.
`;

  const userContent = `
==================================================
INPUT DATA
==================================================

REGISTERED SPEAKERS:
${JSON.stringify(allSpeakers || [])}

ALLOWED SPEAKER TAGS (closed set — never output anything else):
${JSON.stringify(allowedSpeakerTags)}

ESTABLISHED SPEAKER TAGS (already observed before this batch):
${JSON.stringify(establishedSpeakerTags)}

MEETING CONTEXT:
${context || "General discussion"}

EARLIER CONVERSATION SUMMARY (who's who, topics discussed before the recent history below — use this to resolve speaker identity for references beyond the recent window):
${rolling_summary || "(none yet)"}

CONVERSATION HISTORY (Last ${historyContext.length} completed lines):
${historyContext.length > 0 ? JSON.stringify(historyContext) : "(empty — this is the first segment)"}
${coldStartNote}

GLOSSARY (Apply if matching words are found):
${JSON.stringify(glossaryList || [])}

RAW DIALOGUE SEQUENCE TO PROCESS:
${JSON.stringify(draftsContext)}
`;

  const genAI = getGeminiClient();
  const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
  const generationConfig = { responseMimeType: "application/json" as const, temperature: 0.15, topP: 0.85 };
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstructionText,
    generationConfig
  });

  let result;
  try {
    result = await model.generateContent(userContent);
  } catch (err) {
    console.warn(`Model ${modelName} failed, falling back to gemini-3.1-flash-lite:`, err);
    const fallbackModel = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      systemInstruction: systemInstructionText,
      generationConfig
    });
    result = await fallbackModel.generateContent(userContent);
  }

  let responseText = result.response.text().trim();
  
  const startIdx = responseText.indexOf("{");
  const endIdx = responseText.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    responseText = responseText.substring(startIdx, endIdx + 1);
  }
  
  const aiResponse = JSON.parse(responseText);
  const cleanedTurns = aiResponse.cleaned_turns || [];

  const cleanedByIndex = new Map<number, any>();
  for (const turn of cleanedTurns) {
    const index = Number(turn.index);
    if (Number.isInteger(index) && index >= 1 && index <= draftsContext.length && !cleanedByIndex.has(index)) {
      cleanedByIndex.set(index, turn);
    }
  }

  const normalizedTurns = draftsContext.map((input: any, idx: number) => {
    const aiTurn = cleanedByIndex.get(input.index);
    const requestedTag = aiTurn?.speaker_tag;
    const speakerTag = allowedSpeakerTags.includes(requestedTag) ? requestedTag : input.speaker_tag;
    const correctedCandidate = aiTurn?.original_text || aiTurn?.corrected_text || aiTurn?.raw_text || input.text;
    return {
      speaker_tag: speakerTag || "speaker_1",
      original_text: validateCorrectedText(input.text, correctedCandidate),
      translated_text: collapseAdjacentDuplicates(aiTurn?.translated_text || ""),
      start_ms: drafts[idx]?.startMs || 0,
      end_ms: drafts[idx]?.endMs || drafts[idx]?.startMs || 0,
    };
  });

  const groupedTurns: any[] = [];
  for (const turn of normalizedTurns) {
    const prev = groupedTurns[groupedTurns.length - 1];
    if (prev && prev.speaker_tag === turn.speaker_tag) {
      prev.original_text = (prev.original_text + "\n" + turn.original_text).trim();
      prev.translated_text = (prev.translated_text + "\n" + turn.translated_text).trim();
      prev.end_ms = turn.end_ms;
    } else {
      groupedTurns.push({ ...turn });
    }
  }

  const lastTx = last_transcript ? {
    id: last_transcript.id,
    original_text: last_transcript.text,
    translated_text: last_transcript.translatedText,
    start_ms: last_transcript.startMs,
    end_ms: last_transcript.endMs,
    speaker_tag: last_transcript.speakerTag,
    speaker_name: last_transcript.speakerName
  } : null;

  const finalizedBlocks: any[] = [];
  let startIndex = 0;

  if (
    groupedTurns.length > 0 &&
    lastTx &&
    lastTx.speaker_tag === groupedTurns[0]?.speaker_tag &&
    groupedTurns[0].start_ms >= lastTx.end_ms &&
    (groupedTurns[0].start_ms - lastTx.end_ms) < 3000
  ) {
    const firstTurn = groupedTurns[0];
    const mergedOriginal = (lastTx.original_text + "\n" + firstTurn.original_text).trim();
    const mergedTranslated = (lastTx.translated_text + "\n" + firstTurn.translated_text).trim();

    finalizedBlocks.push({
      id: lastTx.id,
      text: mergedOriginal,
      correctedText: mergedOriginal,
      translatedText: mergedTranslated,
      speakerTag: firstTurn.speaker_tag,
      speakerName: lastTx.speaker_name || (firstTurn.speaker_tag === "speaker_1" ? "Speaker 1" : firstTurn.speaker_tag.replace("speaker_", "Speaker ")),
      startMs: lastTx.start_ms,
      endMs: firstTurn.end_ms,
      confidence: 1.0,
      status: "completed",
      createdAt: new Date().toISOString(),
    });
    startIndex = 1; 
  }

  for (let i = startIndex; i < groupedTurns.length; i++) {
    const turn = groupedTurns[i];
    const turnSpeakerTag = turn.speaker_tag || "speaker_1";
    
    const speakerObj = allSpeakers?.find((s: any) => s.speaker_tag === turnSpeakerTag);
    const speakerName = speakerObj?.display_name || (turnSpeakerTag === "speaker_1" ? "Speaker 1" : turnSpeakerTag.replace("speaker_", "Speaker "));

    finalizedBlocks.push({
      id: crypto.randomUUID(),
      text: turn.original_text,
      correctedText: turn.original_text,
      translatedText: turn.translated_text,
      speakerTag: turnSpeakerTag,
      speakerName: speakerName,
      startMs: turn.start_ms,
      endMs: turn.end_ms,
      confidence: 1.0,
      status: "completed",
      createdAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    blocks: finalizedBlocks
  });
}

async function handleSummarizeLine(body: any) {
  const { originalText, translatedText, sourceLang, targetLang } = body;

  if (!originalText) {
    return NextResponse.json({ error: "Missing originalText" }, { status: 400 });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
  }

  const translationModelName = process.env.AI_TRANSLATION_MODEL || "gemini-3.1-flash-lite";

  let originalSummary = originalText;
  if (originalText.length > 30) {
    const originalPrompt = `
You are a helpful assistant.
Task: Summarize the following text briefly (in 1 or 2 sentences max) in its original language (${sourceLang || "auto"}).
- Return only the summary text. Do not add explanations or notes.
Text: "${originalText}"
`;
    originalSummary = await runWithGeminiClient(async (client) => {
      const model = client.getGenerativeModel({ model: translationModelName });
      const result = await model.generateContent(originalPrompt);
      return result.response.text().trim();
    });
  }

  let translatedSummary = translatedText || "";
  if (translatedText && translatedText.length > 30) {
    const translatedPrompt = `
You are a helpful assistant.
Task: Summarize the following text briefly (in 1 or 2 sentences max) in Vietnamese.
- Return only the summary text. Do not add explanations or notes.
Text: "${translatedText}"
`;
    translatedSummary = await runWithGeminiClient(async (client) => {
      const model = client.getGenerativeModel({ model: translationModelName });
      const result = await model.generateContent(translatedPrompt);
      return result.response.text().trim();
    });
  }

  return NextResponse.json({ originalSummary, translatedSummary });
}

async function handleSummarizeRolling(body: any) {
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
}

async function handleTranslateLine(body: any) {
  const { text, lines, source_language, target_language, glossary } = body;

  const inputLines: string[] = Array.isArray(lines)
    ? lines.filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0)
    : typeof text === "string" && text.trim()
      ? [text]
      : [];

  if (inputLines.length === 0) {
    return NextResponse.json({ error: "Missing text/lines" }, { status: 400 });
  }

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
        const model = client.getGenerativeModel({
          model: "gemini-3.1-flash-lite",
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            topP: 1,
          },
        });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
      });

      let jsonText = raw;
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
      }
      const parsed = JSON.parse(jsonText);
      const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];

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
        corrected_text: results[0].corrected_text,
        translated_text: results[0].translated_text,
      });
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.error("[translate-line] failed:", lastError);
  const fallback = inputLines.map((line) => ({ corrected_text: line, translated_text: "" }));
  return NextResponse.json({
    results: fallback,
    corrected_text: fallback[0].corrected_text,
    translated_text: "",
  });
}

async function handleTranslateText(body: any) {
  const { text, texts, sections, sourceLang, targetLang } = body;

  if (!text && (!texts || !Array.isArray(texts)) && !sections) {
    return NextResponse.json({ error: "Missing text, texts array, or sections object" }, { status: 400 });
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
  }

  const translationModelName = "gemini-3.1-flash-lite";

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
    if (rawResponse.startsWith("```")) {
      rawResponse = rawResponse.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
    }
    try {
      const parsed = JSON.parse(rawResponse);
      return NextResponse.json({ translatedSections: parsed });
    } catch (e) {
      console.error("Failed to parse batch sections translation response:", rawResponse, e);
      return NextResponse.json({ translatedSections: sections });
    }
  }

  if (texts && Array.isArray(texts)) {
    if (texts.length === 0) {
      return NextResponse.json({ translatedTexts: [] });
    }

    const chunks = [];
    const chunkSize = 50;
    for (let i = 0; i < texts.length; i += chunkSize) {
      chunks.push(texts.slice(i, i + chunkSize));
    }

    const translatedChunks = await mapWithConcurrency(chunks, TRANSLATION_CONCURRENCY, async (chunk) => {
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

      return withTranslationRetry(async () => {
        const rawText = await runWithGeminiClient(async (client) => {
          const model = client.getGenerativeModel({ model: translationModelName });
          const result = await model.generateContent(prompt);
          return result.response.text().trim();
        });

        let rawResponse = rawText;
        if (rawResponse.startsWith("```")) {
          rawResponse = rawResponse.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
        }
        const parsed = JSON.parse(rawResponse);
        if (!Array.isArray(parsed) || parsed.length !== chunk.length) {
          throw new Error(`Translation response length mismatch: expected ${chunk.length}`);
        }
        return parsed.map((value) => String(value || "").trim());
      });
    });

    const translatedTexts = translatedChunks.flat();
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
}

// ============================================================================
// MAIN DISPATCHER
// ============================================================================

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const body = await request.json();

    switch (action) {
      case "process-transcript":
        return await handleProcessTranscript(body);
      case "process-transcript-batch":
        return await handleProcessTranscriptBatch(body);
      case "summarize-line":
        return await handleSummarizeLine(body);
      case "summarize-rolling":
        return await handleSummarizeRolling(body);
      case "translate-line":
        return await handleTranslateLine(body);
      case "translate-text":
        return await handleTranslateText(body);
      default:
        return NextResponse.json({ error: "Invalid or missing action query parameter" }, { status: 400 });
    }
  } catch (error: any) {
    console.error("ai-handler POST error:", error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
