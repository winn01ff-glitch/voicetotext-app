import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, drafts, fullTranscript, history, last_transcript, target_language } = body;

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

    // 3. Define historyContext using body-passed history
    const historyContext = history || [];




    const isMultiSpeakerMode = allSpeakers && allSpeakers.length > 2;

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

    // Fetch only the last 1000 characters of the raw continuous transcript for context
    const trimmedFullTranscript = fullTranscript && fullTranscript.length > 1000 
      ? "..." + fullTranscript.slice(-1000) 
      : fullTranscript;

    const systemPrompt = `
You are an expert dialogue editor and translator. Your job is to process raw speech transcript segments from a live conversation.

PRIORITY WORKFLOW — CONTEXT-FIRST CLASSIFICATION:
1. FIRST: Read the FULL CONTINUOUS TRANSCRIPT below to understand the complete conversation flow, who is asking questions, who is answering, and the overall context.
2. SECOND: Read the RAW DIALOGUE SEQUENCE.
3. CLASSIFY SPEAKERS based on your understanding of the conversation context (who would logically say what).
4. Assign correct speaker tags from the REGISTERED SPEAKERS list based on dialog logic and history.

REGISTERED SPEAKERS (Map to these tags: e.g. speaker_1, speaker_2):
${JSON.stringify(allSpeakers || [])}

CONVERSATION HISTORY (Use for reference and xưng hô/politeness consistency):
${JSON.stringify(historyContext)}

CONTEXT OF THE MEETING:
${context || "General business/technical discussion"}

GLOSSARY (Must apply if matching words are found):
${JSON.stringify(glossaryList || [])}

FULL CONTINUOUS TRANSCRIPT (READ THIS FIRST for complete context understanding):
${trimmedFullTranscript || "(not available)"}

RAW DIALOGUE SEQUENCE TO PROCESS (Input text stream):
${JSON.stringify(draftsContext)}

RULES:
1. CONTEXT-FIRST SPEAKER CLASSIFICATION:
   - Your understanding of the conversation context takes priority.
   - The 'speaker_tag' in the RAW DIALOGUE SEQUENCE is a biometric voice-analysis hint from Deepgram. If it seems reasonable and fits the context, keep it. If it seems suspicious or illogical (e.g. a question and its answer are assigned to the same tag, or speaker tags flicker randomly), use your semantic context understanding to correct the speaker assignment.
   - If a question and answer are both grouped in the same raw segment, SPLIT them and assign correct speakers.
   - Use language clues: who speaks Japanese, English, or Vietnamese.

2. STRICT SPEAKER GROUPING & NO DUPLICATES:
   - Group consecutive turns of the SAME speaker. Do NOT return consecutive turns with the same speaker_tag.
   - Clean extreme stuttering or word loops (5+ repetitions).

3. LISTENING RESPONSES (AIZUCHI / BACKCHANNELS):
   - Listening responses (e.g. Japanese: "なるほど", "うん", "はい", "そうですね"; English: "yeah", "okay", "I see"; Vietnamese: "vâng", "dạ", "thế à") belong to the LISTENER, not the speaker.
   - If a backchannel appears at the end or beginning of someone's turn, split and assign it to the other speaker.

4. ABSOLUTE WORD PRESERVATION & MINIMAL CORRECTION:
   - For 'original_text': ONLY fix obvious speech recognition errors (wrong kanji, garbled characters, spelling typos).
   - Do NOT merge, remove, rephrase, or restructure sentences.
   - Keep EVERY word from raw input. Keep casual/polite register as spoken.
   - Only fix: spelling errors, glossary substitutions, split word gluing, extreme stutter removal.
   - NEVER change one valid word into a completely different word (e.g. NEVER change "そうか" to "そうそう", or "ね" to "はい").

5. TRANSLATION:
   - Translate each turn into "${targetLang}" naturally and faithfully.
   - If the original text is already in "${targetLang}", the 'translated_text' MUST equal 'original_text' exactly.

OUTPUT FORMAT:
Return valid JSON ONLY. No markdown, no explanations.
{
  "cleaned_turns": [
    {
      "speaker_tag": "correct speaker tag (e.g. speaker_1, speaker_2)",
      "original_text": "corrected source text",
      "translated_text": "translation into ${targetLang}"
    }
  ]
}

==================================================
FEW-SHOT EXAMPLES FOR ALL LANGUAGES (JAPANESE, ENGLISH, VIETNAMESE)
==================================================

[EXAMPLE 1: JAPANESE -> VIETNAMESE]
- INPUT: [{"index": 1, "speaker_tag": "speaker_1", "text": "はじめましてですね。初めまして、嬉しい つながることができて嬉しいです。ありがとうございます 今はるかさんは どこに住んでるんですか。"}]
- OUTPUT JSON:
{
  "cleaned_turns": [
    {
      "speaker_tag": "speaker_2",
      "original_text": "はじめましてですね。初めまして、嬉しいです。つながることができて嬉しいです。ありがとうございます。",
      "translated_text": "Lần đầu gặp mặt nhỉ. Rất vui được gặp bạn, mình rất vui vì chúng ta có thể kết nối được với nhau. Cảm ơn bạn."
    },
    {
      "speaker_tag": "speaker_1",
      "original_text": "今、はるかさんはどこに住んでるんですか。",
      "translated_text": "Hiện tại Haruka-san đang sống ở đâu thế?"
    }
  ]
}

[EXAMPLE 2: JAPANESE BACKCHANNELS & STRICT WORD PRESERVATION]
- INPUT: [{"index": 1, "speaker_tag": "speaker_1", "text": "フランスでフランスにいた時にyoutube撮りましたよね最後そうかはいはいはいゲームの話とか覚えてます"}]
- OUTPUT JSON:
{
  "cleaned_turns": [
    {
      "speaker_tag": "speaker_1",
      "original_text": "フランスで、フランスにいた時にYouTube撮りましたよね。",
      "translated_text": "Ở Pháp ấy? Lúc bạn ở Pháp chúng ta đã quay video YouTube đúng không nhỉ?"
    },
    {
      "speaker_tag": "speaker_2",
      "original_text": "ね。最後、そうか。はいはいはい。",
      "translated_text": "Đúng thế, lần cuối cùng ấy. À ra vậy. Vâng vâng vâng."
    },
    {
      "speaker_tag": "speaker_1",
      "original_text": "ゲームの話とか覚えてます？",
      "translated_text": "Bạn có nhớ vụ chúng ta nói về game không?"
    }
  ]
}

[EXAMPLE 3: ENGLISH -> VIETNAMESE]
- INPUT: [{"index": 1, "speaker_tag": "speaker_1", "text": "hello how are you today i am fine thanks and you what is your name"}]
- OUTPUT JSON:
{
  "cleaned_turns": [
    {
      "speaker_tag": "speaker_1",
      "original_text": "Hello, how are you today?",
      "translated_text": "Xin chào, hôm nay bạn thế nào?"
    },
    {
      "speaker_tag": "speaker_2",
      "original_text": "I am fine, thanks. And you?",
      "translated_text": "Tôi khỏe, cảm ơn bạn. Còn bạn thì sao?"
    },
    {
      "speaker_tag": "speaker_1",
      "original_text": "What is your name?",
      "translated_text": "Bạn tên là gì thế?"
    }
  ]
}

[EXAMPLE 4: VIETNAMESE -> VIETNAMESE]
- INPUT: [{"index": 1, "speaker_tag": "speaker_1", "text": "xin chao cac ban hom nay chung ta hoc tiéng nhat nhe vang dung the"}]
- OUTPUT JSON:
{
  "cleaned_turns": [
    {
      "speaker_tag": "speaker_1",
      "original_text": "Xin chào các bạn, hôm nay chúng ta học tiếng Nhật nhé.",
      "translated_text": "Xin chào các bạn, hôm nay chúng ta học tiếng Nhật nhé."
    },
    {
      "speaker_tag": "speaker_2",
      "original_text": "Vâng, đúng thế.",
      "translated_text": "Vâng, đúng thế."
    }
  ]
}

==================================================
OUTPUT
==================================================

Return ONLY valid JSON.

Do not output Markdown.

Do not explain reasoning.

Do not wrap JSON in code fences.

Schema

{
  "cleaned_turns":[
    {
      "speaker_tag":"speaker_1",
      "original_text":"...",
      "translated_text":"..."
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
        speakerName: lastTx.speaker_name || (firstTurn.speaker_tag === "speaker_1" ? "Tôi" : firstTurn.speaker_tag.replace("speaker_", "Speaker ")),
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
      const speakerName = speakerObj?.display_name || (turnSpeakerTag === "speaker_1" ? "Tôi" : turnSpeakerTag.replace("speaker_", "Speaker "));

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
