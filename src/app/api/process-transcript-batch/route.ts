import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getGeminiClient } from "@/lib/ai/geminiClient";

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
  // STT correction may fix characters, but it must not substantially expand or
  // delete the spoken segment. Reject likely hallucination/duplication.
  if (outputLength > inputLength * 1.35 || outputLength < inputLength * 0.65) return input;
  return cleaned;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, drafts, history, last_transcript, target_language, diarize_enabled, rolling_summary } = body;

    if (!meeting_id || !drafts || !Array.isArray(drafts) || drafts.length === 0) {
      return NextResponse.json({ error: "Missing required fields (meeting_id, drafts)" }, { status: 400 });
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

    // 3. Define historyContext using body-passed history (up to 30 completed lines)
    const historyContext = history || [];

    // 4. Prepare drafts context
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
    const diarizeMode = diarize_enabled !== false; // Default: true

    // Language-specific labels and instructions
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

    // Cold start handling
    const coldStartNote = historyContext.length === 0
      ? `
⚠️ COLD START: There is NO conversation history yet. This is the very first segment of the meeting.
- ${diarizeMode
          ? "Use Deepgram tags as audio hints, not identities. Streaming diarization may temporarily emit speaker_3+ for one of the first two voices. Prefer the smallest speaker set supported by clear dialogue evidence; keep a third tag only when the text clearly shows a genuinely distinct third participant."
          : "Since there is no history AND no audio hints, rely entirely on linguistic structure within THIS segment. The first person speaking is most likely speaker_1 (the meeting organizer). Only split into multiple speakers if there are very clear dialogue transitions (Question→Answer, pronoun shifts, register changes) within the segment."
        }
- As more segments are processed, future calls will include conversation history for better accuracy.`
      : "";

    // Diarize mode instruction
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


    // 4. Setup Gemini Client & Call API
    const genAI = getGeminiClient();
    const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
    // Low temperature: speaker assignment + translation are factual tasks with a "correct answer",
    // not creative writing — keep sampling close to deterministic.
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
    
    // Robustly extract the JSON object to ignore markdown wrappers or explanations
    const startIdx = responseText.indexOf("{");
    const endIdx = responseText.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      responseText = responseText.substring(startIdx, endIdx + 1);
    }
    
    const aiResponse = JSON.parse(responseText);
    const cleanedTurns = aiResponse.cleaned_turns || [];

    // 5. Re-align AI output with the immutable input indices. Gemini may omit,
    // duplicate or reorder items despite the prompt; index-based reconstruction
    // guarantees that no spoken segment or original timestamp is lost.
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

    // Chỉ merge các input word-runs LIỀN KỀ đã được gán cùng speaker, đồng thời
    // giữ start/end thật thay vì chia đều timestamp theo số block AI trả về.
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

    // 6. Map last_transcript to lastTx
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

    // Check if we can merge the first turn into lastTx
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
      startIndex = 1; // Skip the first turn since we merged it
    }

    // Generate remaining turns locally
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
  } catch (error) {
    console.error("Process transcript batch error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
