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
    const fastModelName = process.env.AI_FAST_MODEL || "gemini-flash-latest";
    const model = genAI.getGenerativeModel({ model: fastModelName });

    const targetLang = meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;

    const systemPrompt = `
Bạn là một trợ lý dịch thuật thông minh thời gian thực.
Nhiệm vụ của bạn là nhận câu thoại thô, sửa lỗi, dịch và trích xuất Action Item.
BẠN BẮT BUỘC PHẢI TRẢ VỀ ĐÚNG ĐỊNH DẠNG TEXT DƯỚI ĐÂY (không dùng JSON, không dùng Markdown code block):

---CORRECTED---
(văn bản đã sửa lỗi chính tả bằng ngôn ngữ gốc ${sourceLang}. QUAN TRỌNG: Chỉ sửa lỗi chính tả thực sự nghiêm trọng hoặc từ vô nghĩa. Nếu câu gốc đã chuẩn và có nghĩa, BẠN BẮT BUỘC PHẢI GIỮ NGUYÊN 100% câu gốc, không được tự ý thay đổi từ vựng, hành văn hoặc cấu trúc câu)
---TRANSLATED---
(văn bản dịch sát nghĩa sang ${targetLang})
---ACTION_ITEMS---
(danh sách action item dạng JSON array hợp lệ: [{"description": "...", "owner": "...", "deadline": "..."}]. Nếu không có thì trả về [])
---CONFIDENCE---
(điểm tự tin từ 0.0 đến 1.0, ví dụ 0.95)

Ngữ cảnh: "${context}"
Glossary: ${JSON.stringify(glossaryList || [])}

Câu thoại cần xử lý:
"${original_text}"
`;

    const result = await model.generateContent(systemPrompt);
    const fullText = result.response.text();

    const correctedMatch = fullText.match(/---CORRECTED---\s*([\s\S]*?)(?=\s*---|$)/);
    const translatedMatch = fullText.match(/---TRANSLATED---\s*([\s\S]*?)(?=\s*---|$)/);
    const actionItemsMatch = fullText.match(/---ACTION_ITEMS---\s*([\s\S]*?)(?=\s*---|$)/);
    const confidenceMatch = fullText.match(/---CONFIDENCE---\s*([\s\S]*?)(?=\s*---|$)/);

    const finalCorrected = correctedMatch ? correctedMatch[1].trim() : original_text;
    const finalTranslated = translatedMatch ? translatedMatch[1].trim() : "";
    const finalConfidence = confidenceMatch ? parseFloat(confidenceMatch[1].trim()) : confidence;
    
    let finalActionItems = [];
    try {
      if (actionItemsMatch) finalActionItems = JSON.parse(actionItemsMatch[1].trim());
    } catch (e) {}

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
