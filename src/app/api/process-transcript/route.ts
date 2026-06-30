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
    const modelName = process.env.AI_FAST_MODEL || "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const targetLang = meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;

    const systemPrompt = `
Bạn là một trợ lý chỉnh sửa và dịch thuật hội thoại thông minh.
Nhiệm vụ của bạn là nhận câu thoại gốc từ hệ thống Speech-to-Text, chèn thêm dấu câu phù hợp, và dịch sang ngôn ngữ đích.

QUY TẮC BẤT BIẾN CHO CORRECTED TEXT (---CORRECTED---):
1. Bạn CHỈ ĐƯỢC PHÉP thêm các dấu câu (chấm, phẩy, hỏi, chấm than...) và viết hoa chữ cái đầu câu hoặc danh từ riêng (nếu cần).
2. Bạn TUYỆT ĐỐI KHÔNG ĐƯỢC sửa bất kỳ từ ngữ nào, không tự ý thay đổi cách viết, không đảo thứ tự từ, không sửa chính tả, không diễn đạt lại, không thêm/bớt từ, không tối ưu hóa câu văn. Bạn phải giữ nguyên 100% từ ngữ do Deepgram trả về.
3. Ví dụ:
   - Gốc: "hom nay toi muon di tokyo ngay mai" -> Sửa: "Hôm nay tôi muốn đi Tokyo ngày mai." (Đúng quy tắc)
   - Gốc: "hom nay toi muon di tokyo ngay mai" -> Sửa: "Ngày mai tôi muốn đi Tokyo." (SAI QUY TẮC - vi phạm do đổi thứ tự từ và cấu trúc)
   - Gốc: "hom nay toi muon di tokyo ngay mai" -> Sửa: "Tôi dự định sẽ đi Tokyo vào ngày mai." (SAI QUY TẮC - vi phạm do diễn đạt lại)

BẠN BẮT BUỘC PHẢI TRẢ VỀ ĐÚNG ĐỊNH DẠNG TEXT DƯỚI ĐÂY (không dùng JSON, không dùng Markdown code block):

---CORRECTED---
(văn bản đã chèn dấu câu gốc. TUYỆT ĐỐI GIỮ NGUYÊN 100% TỪ NGỮ GỐC, CHỈ THÊM DẤU CÂU VÀ VIẾT HOA ĐẦU CÂU)
---TRANSLATED---
(văn bản dịch sát nghĩa sang ${targetLang}. Sử dụng Glossary dưới đây nếu có)
---ACTION_ITEMS---
(danh sách action item dạng JSON array hợp lệ: [{"description": "...", "owner": "...", "deadline": "..."}]. Nếu không có thì trả về [])
---CONFIDENCE---
(điểm tự tin từ 0.0 đến 1.0, ví dụ 0.95)

Ngữ cảnh: "${context}"
Glossary: ${JSON.stringify(glossaryList || [])}

Câu thoại cần xử lý:
"${original_text}"
`;

    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (err) {
      console.warn(`Model ${modelName} failed, falling back to gemini-3.1-flash-lite:`, err);
      const fallbackModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
      result = await fallbackModel.generateContent(systemPrompt);
    }
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
