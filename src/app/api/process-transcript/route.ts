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
      console.error("Fetch meeting error:", meetingError);
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // 2. Fetch glossary
    const { data: glossaryList, error: glossaryError } = await supabase
      .from("glossary")
      .select("source, target, source_language, target_language")
      .eq("meeting_id", meeting_id);

    if (glossaryError) {
      console.error("Fetch glossary error:", glossaryError);
    }

    // 3. Setup Gemini Client & Call API
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const fastModelName = process.env.AI_FAST_MODEL || "gemini-1.5-flash";
    const model = genAI.getGenerativeModel({
      model: fastModelName,
      generationConfig: { responseMimeType: "application/json" },
    });

    const targetLang = meeting.target_language;
    const sourceLang = meeting.source_language;
    const context = meeting.meeting_context;

    const systemPrompt = `
Bạn là một trợ lý dịch thuật và biên bản cuộc họp thông minh.
Nhiệm vụ của bạn là nhận một câu thoại thô từ máy nhận dạng giọng nói, thực hiện các tác vụ sau cùng một lúc và trả về một đối tượng JSON duy nhất:
1. Sửa lỗi chính tả và chuẩn hóa ngữ pháp (corrected_text). Nếu câu thoại đã chuẩn, hãy giữ nguyên.
2. Dịch câu thoại sang ngôn ngữ đích: "${targetLang}" (translated_text).
3. Tra cứu Glossary (từ điển chuyên ngành được cấp) và chuẩn hóa tên riêng hoặc thuật ngữ kỹ thuật.
4. Phát hiện xem câu thoại này có chứa Action Item (công việc được phân công) nào không. Nếu có, trích xuất mô tả (description), người thực hiện (owner), và thời hạn hoàn thành (deadline) dạng ISO 8601 (nếu có nhắc đến mốc thời gian cụ thể) hoặc null.
5. Đánh giá độ tự tin dịch thuật của chính bạn từ 0.0 đến 1.0 (confidence_score).

Thông tin ngữ cảnh cuộc họp:
- Ngữ cảnh: "${context}"
- Ngôn ngữ nguồn chính của cuộc họp: "${sourceLang}"
- Danh sách Glossary: ${JSON.stringify(glossaryList || [])}

Câu thoại cần xử lý:
"${original_text}"

Hãy trả về một đối tượng JSON duy nhất khớp với cấu trúc sau:
{
  "corrected_text": "văn bản đã sửa lỗi chính tả bằng ngôn ngữ gốc",
  "translated_text": "văn bản dịch sang ${targetLang}",
  "action_items": [
    {
      "description": "mô tả công việc cần làm",
      "owner": "tên người thực hiện hoặc null",
      "deadline": "mốc thời gian dạng ISO 8601 hoặc null"
    }
  ],
  "glossary_matches": ["danh sách các từ trong glossary khớp trong câu"],
  "confidence_score": 0.95
}
`;

    const aiResponse = await model.generateContent(systemPrompt);
    const responseText = aiResponse.response.text();
    const aiResult = JSON.parse(responseText);

    // 4. Resolve Speaker ID (create one if not exists)
    let speakerId = null;
    if (speaker_tag) {
      const { data: speaker, error: speakerError } = await supabase
        .from("speakers")
        .select("id")
        .eq("meeting_id", meeting_id)
        .eq("speaker_tag", speaker_tag)
        .maybeSingle();

      if (speaker) {
        speakerId = speaker.id;
      } else {
        // Auto create speaker if missing
        const { data: newSpeaker, error: createSpeakerError } = await supabase
          .from("speakers")
          .insert({
            meeting_id: meeting_id,
            speaker_tag: speaker_tag,
            display_name: speaker_tag.replace("speaker_", "Speaker "),
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select()
          .single();

        if (!createSpeakerError && newSpeaker) {
          speakerId = newSpeaker.id;
        }
      }
    }

    // 5. Insert transcript record
    const { data: transcriptRecord, error: insertError } = await supabase
      .from("transcripts")
      .insert({
        meeting_id,
        speaker_id: speakerId,
        original_text,
        corrected_text: aiResult.corrected_text || original_text,
        translated_text: aiResult.translated_text || "",
        translation_language: targetLang,
        translation_provider: "Gemini",
        start_ms: start_ms || 0,
        end_ms: end_ms || 0,
        confidence: confidence || aiResult.confidence_score || 1.0,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // 6. Insert Action Items if detected
    if (aiResult.action_items && aiResult.action_items.length > 0) {
      const actionItemsToInsert = aiResult.action_items.map((item: any) => {
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
        };
      });

      const { error: insertActionError } = await supabase
        .from("action_items")
        .insert(actionItemsToInsert);

      if (insertActionError) {
        console.error("Insert Action Items error:", insertActionError);
      }
    }

    return NextResponse.json({
      status: "success",
      transcript_id: transcriptRecord.id,
      result: {
        corrected_text: aiResult.corrected_text || original_text,
        translated_text: aiResult.translated_text || "",
        action_items: aiResult.action_items || [],
        glossary_matches: aiResult.glossary_matches || [],
        confidence_score: aiResult.confidence_score || confidence || 1.0,
      },
    });
  } catch (error) {
    console.error("Process transcript error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
