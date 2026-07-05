import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, raw_transcript, num_speakers } = body;

    if (!meeting_id || !raw_transcript) {
      return NextResponse.json({ error: "Missing meeting_id or raw_transcript" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const supabase = await createServerSupabaseClient();

    // Get meeting languages & glossary
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("target_language, source_language")
      .eq("id", meeting_id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    const { data: glossaryList } = await supabase
      .from("glossary")
      .select("source, target, source_language, target_language")
      .eq("meeting_id", meeting_id);

    const targetLang = meeting.target_language || "vi";

    // Call Gemini to split speakers and reconstruct turns
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const fastModelName = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
    const model = genAI.getGenerativeModel({
      model: fastModelName,
      generationConfig: { responseMimeType: "application/json" }
    });

    let speakersConstraint = "";
    if (num_speakers && num_speakers !== "auto") {
      speakersConstraint = `\nCRITICAL CONSTRAINT: You MUST detect exactly ${num_speakers} speaker(s) and classify all turns among these ${num_speakers} speakers. Use tags from speaker_1 to speaker_${num_speakers}.`;
    }

    const reprocessPrompt = `
You are an expert dialogue reconstructor. You are given a single continuous block of raw speech text from a multilingual meeting (Vietnamese, Japanese, English).

Your job is to read the entire text, analyze the context of the story, identify all individual speakers, split the text into chronological turns, and translate each turn into the target language: "${targetLang}".

DIRECTIONS:
1. ANALYZE CONTEXT: Read the entire raw text to understand the story, topics, and identify who is speaking to whom.
2. DETECT SPEAKERS: Identify all speakers. You should detect any number of speakers based on the dialogue flow and logic. ${speakersConstraint}
3. RECONSTRUCT DIALOGUE: Split the continuous text block into logical, chronological conversational turns.
4. ASSIGN SPEAKER TAGS: Map each speaker to a consistent tag (e.g., "speaker_1", "speaker_2", "speaker_3", etc.). The host/primary speaker should usually be "speaker_1".
5. TRANSLATION:
   - Translate each turn into "${targetLang}" naturally and faithfully.
   - If the text of a turn is already in "${targetLang}", the 'translated_text' MUST equal 'original_text' exactly.
   - Keep fillers, style, and tone intact.

GLOSSARY (Must apply if matching words are found):
${JSON.stringify(glossaryList || [])}

RAW MEETING TEXT TO PROCESS:
---
${raw_transcript}
---

OUTPUT FORMAT:
Return valid JSON ONLY. No markdown, no explanations.
{
  "speakers_detected": [
    {
      "speaker_tag": "speaker_1",
      "display_name": "Speaker 1"
    },
    ...
  ],
  "turns": [
    {
      "speaker_tag": "speaker_1",
      "original_text": "corrected source text",
      "translated_text": "translation into ${targetLang}"
    }
  ]
}
`;

    let reprocessResult;
    try {
      reprocessResult = await model.generateContent(reprocessPrompt);
    } catch (err) {
      console.warn("Reprocess model failed, falling back to gemini-3.1-flash-lite:", err);
      const fallbackModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig: { responseMimeType: "application/json" }
      });
      reprocessResult = await fallbackModel.generateContent(reprocessPrompt);
    }

    let responseText = reprocessResult.response.text().trim();
    const startIdx = responseText.indexOf("{");
    const endIdx = responseText.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      responseText = responseText.substring(startIdx, endIdx + 1);
    }

    const aiOutput = JSON.parse(responseText);
    const speakersDetected = aiOutput.speakers_detected || [];
    const turns = aiOutput.turns || [];

    if (turns.length === 0) {
      return NextResponse.json({ error: "AI returned no turns" }, { status: 500 });
    }

    // --- Database Update Transaction ---
    // 1. Delete existing transcripts for this meeting (only reprocessed ones)
    const { error: deleteTranscriptsError } = await supabase
      .from("transcripts")
      .delete()
      .eq("meeting_id", meeting_id)
      .eq("is_reprocessed", true);
    if (deleteTranscriptsError) throw deleteTranscriptsError;

    // 2. Delete existing speakers for this meeting (only reprocessed ones)
    const { error: deleteSpeakersError } = await supabase
      .from("speakers")
      .delete()
      .eq("meeting_id", meeting_id)
      .eq("is_reprocessed", true);
    if (deleteSpeakersError) throw deleteSpeakersError;

    // 3. Create new speakers
    const speakerTagToId: Record<string, string> = {};
    for (const sp of speakersDetected) {
      const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
      const randColor = colors[Math.floor(Math.random() * colors.length)];
      const { data: newSp, error: newSpError } = await supabase
        .from("speakers")
        .insert({
          meeting_id,
          speaker_tag: `reprocessed_${sp.speaker_tag}`,
          display_name: sp.display_name || sp.speaker_tag.replace("speaker_", "Speaker "),
          color_hex: randColor,
          is_reprocessed: true
        })
        .select()
        .single();
      
      if (newSpError) throw newSpError;
      if (newSp) {
        speakerTagToId[sp.speaker_tag] = newSp.id;
      }
    }

    // If any speaker tags in turns are missing from speakerTagToId, auto-create them
    for (const turn of turns) {
      const tag = turn.speaker_tag || "speaker_1";
      if (!speakerTagToId[tag]) {
        const { data: newSp } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag: `reprocessed_${tag}`,
            display_name: tag.replace("speaker_", "Speaker "),
            color_hex: "#3b82f6",
            is_reprocessed: true
          })
          .select()
          .single();
        if (newSp) {
          speakerTagToId[tag] = newSp.id;
        }
      }
    }

    // 4. Insert new transcripts
    const { data: meetingDetails } = await supabase
      .from("meetings")
      .select("duration_ms")
      .eq("id", meeting_id)
      .single();
    
    const duration = meetingDetails?.duration_ms || 60000;
    const step = Math.round(duration / turns.length);

    const insertRows = turns.map((t: any, index: number) => ({
      meeting_id,
      speaker_id: speakerTagToId[t.speaker_tag] || null,
      original_text: t.original_text,
      corrected_text: t.original_text,
      translated_text: t.translated_text,
      translation_language: targetLang,
      translation_provider: "Gemini",
      start_ms: step * index,
      end_ms: step * (index + 1),
      confidence: 1.0,
      is_reprocessed: true
    }));

    const { error: insertTranscriptsError } = await supabase
      .from("transcripts")
      .insert(insertRows);
    
    if (insertTranscriptsError) throw insertTranscriptsError;

    // 5. Regenerate Summary & Action Items
    const transcriptLog = turns.map((t: any) => {
      const spObj = speakersDetected.find((s: any) => s.speaker_tag === t.speaker_tag);
      const speakerName = spObj?.display_name || t.speaker_tag;
      return `${speakerName}: ${t.original_text} (Dịch: ${t.translated_text || "N/A"})`;
    }).join("\n");

    const qualityModelName = process.env.AI_QUALITY_MODEL || "gemini-2.5-pro";
    const qualityModel = genAI.getGenerativeModel({
      model: qualityModelName,
      generationConfig: { responseMimeType: "application/json" }
    });

    const summaryPrompt = `
Bạn là một thư ký cuộc họp chuyên nghiệp sử dụng mô hình trí tuệ nhân tạo chất lượng cao.
Nhiệm vụ của bạn là đọc toàn bộ biên bản cuộc họp sau đây và trả về một báo cáo tóm tắt chất lượng cao dưới dạng JSON:
1. Executive Summary (Tóm tắt tổng quan): Một đoạn văn ngắn gọn mô tả mục đích và kết quả chung của cuộc họp.
2. Key Decisions (Quyết định cốt lõi): Danh sách các quyết định hoặc thỏa thuận quan trọng đã được thông qua.
3. Action Items (Danh sách công việc): Danh sách các công việc cụ thể được phân công, bao gồm tên người chịu trách nhiệm (owner) và thời hạn hoàn thành (deadline) dạng ISO 8601 hoặc mô tả thời gian (ví dụ: "Ngày mai", "Thứ Sáu tới") hoặc null nếu không rõ ràng.

Biên bản cuộc họp cần phân tích:
---
${transcriptLog}
---

Hãy trả về một đối tượng JSON khớp chính xác với cấu trúc sau:
{
  "executive_summary": "nội dung tóm tắt tổng quan cuộc họp...",
  "decisions": [
    "Quyết định thứ nhất...",
    "Quyết định thứ hai..."
  ],
  "action_items": [
    {
      "description": "Nội dung công việc...",
      "owner": "Tên người chịu trách nhiệm...",
      "deadline": "Thời gian hoàn thành..."
    }
  ]
}
`;

    let aiSummaryResponse;
    try {
      aiSummaryResponse = await qualityModel.generateContent(summaryPrompt);
    } catch (err) {
      console.warn("Summary quality model failed, falling back to fast model:", err);
      const fallbackModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig: { responseMimeType: "application/json" }
      });
      aiSummaryResponse = await fallbackModel.generateContent(summaryPrompt);
    }

    let summaryText = aiSummaryResponse.response.text().trim();
    const summaryStartIdx = summaryText.indexOf("{");
    const summaryEndIdx = summaryText.lastIndexOf("}");
    if (summaryStartIdx !== -1 && summaryEndIdx !== -1 && summaryEndIdx > summaryStartIdx) {
      summaryText = summaryText.substring(summaryStartIdx, summaryEndIdx + 1);
    }
    const summaryResult = JSON.parse(summaryText);

    // Save summary and decisions to ai_summaries table under reprocessed fields
    const { error: saveSummaryError } = await supabase
      .from("ai_summaries")
      .update({
        status: "Completed",
        reprocessed_executive_summary: summaryResult.executive_summary,
        reprocessed_decisions: summaryResult.decisions || [],
      })
      .eq("meeting_id", meeting_id);
    if (saveSummaryError) throw saveSummaryError;

    // Delete existing reprocessed Action Items
    await supabase.from("action_items")
      .delete()
      .eq("meeting_id", meeting_id)
      .eq("is_reprocessed", true);

    // Insert new reprocessed Action Items
    if (summaryResult.action_items && summaryResult.action_items.length > 0) {
      const actionItemsToInsert = summaryResult.action_items.map((item: any) => {
        let parsedDeadline = null;
        if (item.deadline) {
          const d = new Date(item.deadline);
          if (!isNaN(d.getTime())) {
            parsedDeadline = d.toISOString();
          }
        }
        return {
          meeting_id,
          description: item.description,
          owner: item.owner || null,
          deadline: parsedDeadline,
          is_completed: false,
          is_reprocessed: true
        };
      });
      await supabase.from("action_items").insert(actionItemsToInsert);
    }

    return NextResponse.json({ status: "success" });

  } catch (error) {
    console.error("Reprocess raw transcript error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
