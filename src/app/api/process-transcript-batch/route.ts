import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiClient } from "@/lib/ai/geminiClient";

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
          ? "Trust Deepgram's speaker_tag hints more heavily since there is no prior context to cross-reference. Assign the first speaker as the one registered first in the REGISTERED SPEAKERS list (usually speaker_1)."
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
   - If a segment contains dialogue from MULTIPLE speakers, split it into separate blocks.`
      : `CONTEXTUAL SPEAKER DIARIZATION (100% Semantic-based):
   - Audio diarization is DISABLED. All input is tagged "speaker_1" by default — ignore this tag.
   - You MUST detect speaker changes using ONLY:
     • Dialogue transitions: Question → Answer, Statement → Response
     • Pronoun shifts (see language-specific cues above)
     • Register/tone changes
     • Language switches (if applicable)
   - Cross-reference with CONVERSATION HISTORY to match speech patterns to known speakers.
   - If a new speaker appears who is not registered, assign a new sequential tag (e.g., "speaker_3").`;

    const systemPrompt = `
You are an expert dialogue editor, speaker classifier, and translator for live meeting transcription.

==================================================
LANGUAGE CONFIGURATION
==================================================
Source Language: ${sourceLangLabel[sourceLang] || sourceLangLabel["auto"]}
Target Language: ${targetLang}
${sourceLangInstruction[sourceLang] || sourceLangInstruction["auto"]}

==================================================
INPUT DATA
==================================================

REGISTERED SPEAKERS:
${JSON.stringify(allSpeakers || [])}

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

==================================================
INSTRUCTIONS
==================================================

1. ${diarizeInstruction}

2. LISTENING RESPONSES / BACKCHANNELS:
   - These belong to the LISTENER, not the current speaker. Split them out and assign to the other person.
   - Japanese: なるほど, うん, はい, そうですね, ええ, あー
   - English: yeah, okay, I see, right, uh-huh, sure, got it
   - Vietnamese: vâng, dạ, ừ, thế à, đúng rồi, à ra vậy

3. STRICT WORD PRESERVATION:
   - "original_text": ONLY fix obvious ASR errors (wrong kanji, garbled text, diacritics, spelling).
   - Do NOT add, remove, rephrase, or restructure any words.
   - Keep ALL filler words (えー, あの, umm, à, ờ, uh).
   - NEVER change one valid word into a different word.

4. CONSECUTIVE SPEAKER GROUPING:
   - Merge consecutive turns of the SAME speaker. Never return two adjacent blocks with the same speaker_tag.
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
`;


    // 4. Setup Gemini Client & Call API
    const genAI = getGeminiClient();
    const modelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
    // Low temperature: speaker assignment + translation are factual tasks with a "correct answer",
    // not creative writing — keep sampling close to deterministic.
    const generationConfig = { responseMimeType: "application/json" as const, temperature: 0.15, topP: 0.85 };
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig
    });

    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (err) {
      console.warn(`Model ${modelName} failed, falling back to gemini-3.1-flash-lite:`, err);
      const fallbackModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig
      });
      result = await fallbackModel.generateContent(systemPrompt);
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

    // 5. Group consecutive turns of the same speaker inside the batch
    const groupedTurns: any[] = [];
    for (const turn of cleanedTurns) {
      const mappedOriginalText = turn.original_text || turn.corrected_text || turn.raw_text || "";
      const mappedTranslatedText = turn.translated_text || "";
      const mappedSpeakerTag = turn.speaker_tag || "speaker_1";

      const prev = groupedTurns[groupedTurns.length - 1];
      if (prev && prev.speaker_tag === mappedSpeakerTag) {
        prev.original_text = (prev.original_text + "\n" + mappedOriginalText).trim();
        prev.translated_text = (prev.translated_text + "\n" + mappedTranslatedText).trim();
      } else {
        groupedTurns.push({
          speaker_tag: mappedSpeakerTag,
          original_text: mappedOriginalText,
          translated_text: mappedTranslatedText
        });
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

    const startMsVal = drafts[0]?.startMs || Date.now();
    const endMsVal = drafts[drafts.length - 1]?.endMs || Date.now();
    const duration = endMsVal - startMsVal;
    const step = groupedTurns.length > 1 ? Math.round(duration / groupedTurns.length) : duration;

    // Check if we can merge the first turn into lastTx
    if (
      lastTx &&
      lastTx.speaker_tag === groupedTurns[0]?.speaker_tag &&
      (startMsVal - lastTx.end_ms) < 60000 &&
      groupedTurns.length > 0
    ) {
      const firstTurn = groupedTurns[0];
      const mergedOriginal = (lastTx.original_text + "\n" + firstTurn.original_text).trim();
      const mergedTranslated = (lastTx.translated_text + "\n" + firstTurn.translated_text).trim();
      const turnEndMs = startMsVal + step;

      finalizedBlocks.push({
        id: lastTx.id,
        text: mergedOriginal,
        correctedText: mergedOriginal,
        translatedText: mergedTranslated,
        speakerTag: firstTurn.speaker_tag,
        speakerName: lastTx.speaker_name || (firstTurn.speaker_tag === "speaker_1" ? "Speaker 1" : firstTurn.speaker_tag.replace("speaker_", "Speaker ")),
        startMs: lastTx.start_ms,
        endMs: turnEndMs,
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

      const turnStartMs = startMsVal + step * i;
      const turnEndMs = startMsVal + step * (i + 1);

      finalizedBlocks.push({
        id: crypto.randomUUID(),
        text: turn.original_text,
        correctedText: turn.original_text,
        translatedText: turn.translated_text,
        speakerTag: turnSpeakerTag,
        speakerName: speakerName,
        startMs: turnStartMs,
        endMs: turnEndMs,
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
