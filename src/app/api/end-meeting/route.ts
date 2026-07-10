import { NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { meeting_id, duration_ms, transcripts, raw_transcript } = body;

    if (!meeting_id) {
      return NextResponse.json({ error: "Missing meeting_id" }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const supabase = await createServerSupabaseClient();

    // 0. Fetch meeting configuration first to get languages
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("target_language, source_language")
      .eq("id", meeting_id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // 1. Update meeting status to processing
    const { error: updateStatusError } = await supabase
      .from("meetings")
      .update({
        status: "processing",
        duration_ms: duration_ms || 0,
        raw_transcript: raw_transcript || "",
      })
      .eq("id", meeting_id);

    if (updateStatusError) throw updateStatusError;

    // Update AI Summary table status to Generating
    await supabase
      .from("ai_summaries")
      .update({ status: "Generating" })
      .eq("meeting_id", meeting_id);

    // 2. Fetch or create speakers and insert transcripts
    const { data: existingSpeakers } = await supabase
      .from("speakers")
      .select("id, speaker_tag")
      .eq("meeting_id", meeting_id);

    const speakerTagToId: Record<string, string> = {};
    if (existingSpeakers) {
      existingSpeakers.forEach((s: any) => {
        speakerTagToId[s.speaker_tag] = s.id;
      });
    }

    // Create missing speakers in DB
    const uniqueSpeakerTags = Array.from(
      new Set((transcripts || []).map((t: any) => t.speakerTag).filter(Boolean))
    );

    for (const tag of uniqueSpeakerTags as string[]) {
      if (!speakerTagToId[tag]) {
        const { data: newSpeaker } = await supabase
          .from("speakers")
          .insert({
            meeting_id,
            speaker_tag: tag,
            display_name: tag === "speaker_1" ? "Tôi" : tag.replace("speaker_", "Speaker "),
            color_hex: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
          })
          .select()
          .single();
        if (newSpeaker) {
          speakerTagToId[tag] = newSpeaker.id;
        }
      }
    }

    // Insert transcripts to DB
    // Nội dung ở đây đã qua AI (process-transcript-batch) trong lúc họp live,
    // không phải Deepgram thô, nên đánh dấu FINAL thay vì để rơi vào RAW mặc định.
    if ((transcripts || []).length > 0) {
      // Deactivate any existing transcripts for this meeting first
      // (prevents duplicates if end-meeting is called multiple times)
      await supabase.from("transcripts").update({ is_active: false }).eq("meeting_id", meeting_id);

      // Find next version number
      const { data: maxVerData } = await supabase
        .from("transcripts")
        .select("version")
        .eq("meeting_id", meeting_id)
        .order("version", { ascending: false })
        .limit(1)
        .single();
      const nextVersion = (maxVerData?.version || 0) + 1;

      const insertRows = transcripts.map((t: any) => ({
        meeting_id,
        speaker_id: speakerTagToId[t.speakerTag] || null,
        original_text: t.text,
        corrected_text: t.correctedText || t.text,
        translated_text: t.translatedText,
        translation_language: meeting.target_language || "vi",
        translation_provider: "Gemini",
        start_ms: t.startMs,
        end_ms: t.endMs,
        confidence: t.confidence || 1.0,
        version_type: "FINAL",
        version: nextVersion,
        is_active: true,
      }));

      const { error: insertError } = await supabase
        .from("transcripts")
        .insert(insertRows);
      if (insertError) throw insertError;
    }

    // Auto-enqueue background full-context polish (spellcheck/speaker/translation).
    // "summary" is intentionally excluded here: executeSummaryJob inserts a new
    // versioned ai_summaries row, while this route's own summary step below updates
    // the single un-versioned row created at start-meeting — enqueuing both would
    // leave two rows per meeting_id and break the .maybeSingle() read on history page.
    if (insertRows.length > 0) {
      try {
        const enqueuedTypes = await enqueueAiJobs(meeting_id, ["spellcheck", "speaker", "translation"]);
        if (enqueuedTypes.length > 0) {
          after(() => runAIJobsQueue(meeting_id).catch((err) => console.error("[QueueWorker] Background error:", err)));
        }
      } catch (err) {
        // Non-fatal: live-corrected transcript is already saved: worst case the
        // background polish simply doesn't run and the user can retry manually.
        console.error("Failed to auto-enqueue AI polish jobs:", err);
      }
    }

    // 3. Format transcripts into a text log for summary generation
    let transcriptLog = "";
    if (transcripts && transcripts.length > 0) {
      transcriptLog = transcripts
        .map((t: any) => {
          const speakerName = t.speakerName || "Unknown";
          const timeStr = new Date(t.startMs).toISOString().substr(14, 5);
          return `[${timeStr}] ${speakerName}: ${t.correctedText || t.text} (Dịch: ${t.translatedText || "N/A"})`;
        })
        .join("\n");
    } else {
      transcriptLog = "(Không có nội dung đối thoại nào được ghi nhận)";
    }

    // 4. Call Gemini Quality Model to generate summary
    const genAI = new GoogleGenerativeAI(geminiApiKey);
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

    // 5. Save summary and decisions to ai_summaries table
    const { error: saveSummaryError } = await supabase
      .from("ai_summaries")
      .update({
        status: "Completed",
        executive_summary: summaryResult.executive_summary,
        decisions: summaryResult.decisions || [],
      })
      .eq("meeting_id", meeting_id);

    if (saveSummaryError) throw saveSummaryError;

    // 6. Save Action Items to action_items table
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
        };
      });

      // Insert action items (ignore conflicts or simply insert them)
      const { error: insertActionError } = await supabase
        .from("action_items")
        .insert(actionItemsToInsert);

      if (insertActionError) {
        console.error("Insert end-meeting action items error:", insertActionError);
      }
    }

    // 7. Update meeting status to completed
    const { error: updateMeetingCompletedError } = await supabase
      .from("meetings")
      .update({ status: "completed" })
      .eq("id", meeting_id);

    if (updateMeetingCompletedError) throw updateMeetingCompletedError;

    return NextResponse.json({
      status: "success",
      summary: summaryResult.executive_summary,
      decisions: summaryResult.decisions || [],
      action_items: summaryResult.action_items || [],
    });
  } catch (error) {
    console.error("End meeting error:", error);
    // Attempt to set meeting status to failed on database in case of severe exception
    try {
      const body = await request.json().catch(() => ({}));
      if (body.meeting_id) {
        const supabase = await createServerSupabaseClient();
        await supabase.from("meetings").update({ status: "failed" }).eq("id", body.meeting_id);
        await supabase.from("ai_summaries").update({ status: "Draft" }).eq("meeting_id", body.meeting_id);
      }
    } catch {}

    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
