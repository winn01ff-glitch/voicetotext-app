import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiClient } from "@/lib/ai/geminiClient";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id } = body;

    if (!meeting_id) {
      return NextResponse.json({ error: "Missing meeting_id" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Fetch meeting info to get target language
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("title, source_language, target_language, meeting_context")
      .eq("id", meeting_id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // Update status to Generating
    const { error: updateSummaryStatusError } = await supabase
      .from("ai_summaries")
      .update({ status: "Generating" })
      .eq("meeting_id", meeting_id);

    if (updateSummaryStatusError) throw updateSummaryStatusError;

    // 2. Fetch ONLY raw transcripts (from Deepgram)
    let { data: transcripts, error: transcriptsError } = await supabase
      .from("transcripts")
      .select("original_text, corrected_text, translated_text, start_ms, speaker_id, speakers(display_name)")
      .eq("meeting_id", meeting_id)
      .eq("version_type", "RAW")
      .order("start_ms", { ascending: true });

    if (transcriptsError) throw transcriptsError;

    // Fallback if no RAW transcripts found (though there always should be)
    if (!transcripts || transcripts.length === 0) {
      const { data: activeTranscripts, error: activeError } = await supabase
        .from("transcripts")
        .select("original_text, corrected_text, translated_text, start_ms, speaker_id, speakers(display_name)")
        .eq("meeting_id", meeting_id)
        .eq("is_active", true)
        .order("start_ms", { ascending: true });
      if (activeError) throw activeError;
      transcripts = activeTranscripts;
    }

    // 3. Format transcripts using ONLY the original raw Deepgram text
    let transcriptLog = "";
    if (transcripts && transcripts.length > 0) {
      transcriptLog = transcripts
        .map((t: any) => {
          const speakerName = t.speakers?.display_name || "Unknown";
          const timeStr = new Date(t.start_ms).toISOString().substring(14, 19);
          return `[${timeStr}] ${speakerName}: ${t.original_text}`;
        })
        .join("\n");
    } else {
      transcriptLog = "(Không có nội dung đối thoại nào được ghi nhận)";
    }

    const langNames: Record<string, string> = {
      vi: "Tiếng Việt",
      en: "English",
      ja: "日本語",
      zh: "简体中文",
      ko: "한국어",
      fr: "Français",
      de: "Deutsch",
      es: "Español"
    };
    const targetLanguageName = langNames[meeting.target_language] || meeting.target_language || "Tiếng Việt";

    // 4. Call Gemini Quality Model
    const genAI = getGeminiClient();
    const qualityModelName = process.env.AI_QUALITY_MODEL || "gemini-2.5-pro";
    const model = genAI.getGenerativeModel({
      model: qualityModelName,
      generationConfig: { responseMimeType: "application/json" },
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

Hãy viết toàn bộ các trường nội dung tóm tắt (bao gồm executive_summary, decisions, và action items) bằng ngôn ngữ: ${targetLanguageName}.

Hãy trả về một đối tượng JSON khớp chính xác với cấu trúc sau:
{
  "executive_summary": "nội dung tóm tắt tổng quan cuộc họp bằng ${targetLanguageName}...",
  "decisions": [
    "Quyết định thứ nhất bằng ${targetLanguageName}...",
    "Quyết định thứ hai bằng ${targetLanguageName}..."
  ],
  "action_items": [
    {
      "description": "Nội dung công việc bằng ${targetLanguageName}...",
      "owner": "Tên người chịu trách nhiệm...",
      "deadline": "Thời gian hoàn thành..."
    }
  ]
}
`;

    let aiResponse;
    try {
      aiResponse = await model.generateContent(summaryPrompt);
    } catch (err) {
      console.warn(`Summary model ${qualityModelName} failed, falling back to gemini-3.1-flash-lite:`, err);
      const fallbackModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig: { responseMimeType: "application/json" },
      });
      aiResponse = await fallbackModel.generateContent(summaryPrompt);
    }
    const responseText = aiResponse.response.text();
    const summaryResult = JSON.parse(responseText);

    // 5. Delete OLD action items first to prevent duplication
    const { error: deleteActionError } = await supabase
      .from("action_items")
      .delete()
      .eq("meeting_id", meeting_id);

    if (deleteActionError) {
      console.error("Delete old action items error:", deleteActionError);
    }

    // 6. Save new summary
    const { error: saveSummaryError } = await supabase
      .from("ai_summaries")
      .update({
        status: "Completed",
        executive_summary: summaryResult.executive_summary,
        decisions: summaryResult.decisions || [],
      })
      .eq("meeting_id", meeting_id);

    if (saveSummaryError) throw saveSummaryError;

    // Fetch active summary version to keep version alignment for action items
    const { data: activeSummary } = await supabase
      .from("ai_summaries")
      .select("version")
      .eq("meeting_id", meeting_id)
      .eq("is_active", true)
      .maybeSingle();

    const currentVersion = activeSummary?.version || 1;

    // 7. Save new action items
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
          is_active: true,
          version: currentVersion,
        };
      });

      const { error: insertActionError } = await supabase
        .from("action_items")
        .insert(actionItemsToInsert);

      if (insertActionError) {
        console.error("Insert regenerated action items error:", insertActionError);
      }
    }

    return NextResponse.json({
      status: "success",
      summary: summaryResult.executive_summary,
      decisions: summaryResult.decisions || [],
      action_items: summaryResult.action_items || [],
    });
  } catch (error) {
    console.error("Regenerate summary error:", error);
    try {
      const body = await request.json().catch(() => ({}));
      if (body.meeting_id) {
        const supabase = await createServerSupabaseClient();
        await supabase.from("ai_summaries").update({ status: "Completed" }).eq("meeting_id", body.meeting_id);
      }
    } catch {}

    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
