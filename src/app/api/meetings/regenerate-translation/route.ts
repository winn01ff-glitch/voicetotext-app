import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  PipelineConfig,
  step4_translate,
  updateProgress,
  savePipelineStep,
  checkCancelled,
  withRetry,
} from "@/lib/ai/pipeline";

/**
 * Dịch lại transcript
 * Đọc consistency_result từ pipeline_results → chạy lại Step 4 (dịch)
 * KHÔNG gọi lại Deepgram hay chạy lại Step 1-3
 */
export async function POST(request: Request) {
  try {
    const { meeting_id, target_language } = await request.json();

    if (!meeting_id) {
      return NextResponse.json(
        { error: "Thiếu meeting_id." },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();

    // Lấy meeting data
    const { data: meeting, error: fetchError } = await supabase
      .from("meetings")
      .select("*")
      .eq("id", meeting_id)
      .single();

    if (fetchError || !meeting) {
      return NextResponse.json(
        { error: "Không tìm thấy cuộc họp." },
        { status: 404 }
      );
    }

    // Cần có consistency_result hoặc merged_turns để dịch lại
    const inputTurns = meeting.pipeline_results?.consistency_result
      || meeting.pipeline_results?.merged_turns;

    if (!inputTurns) {
      return NextResponse.json(
        { error: "Không có dữ liệu transcript để dịch lại. Cần tạo lại bản ghi trước." },
        { status: 400 }
      );
    }

    // Lấy glossary
    const { data: glossary } = await supabase
      .from("glossary")
      .select("*")
      .eq("meeting_id", meeting_id);

    const config: PipelineConfig = {
      title: meeting.title,
      meetingContext: meeting.meeting_context || "general",
      sourceLanguage: meeting.source_language || "auto",
      targetLanguage: target_language || meeting.target_language,
      speakers: [],
      glossary: (glossary || []).map((g: any) => ({
        source: g.source,
        target: g.target,
        source_language: g.source_language,
        target_language: g.target_language,
      })),
    };

    // Set status
    await supabase
      .from("meetings")
      .update({
        status: "translating",
        progress: { percent: 0, message: "Đang dịch lại..." },
      })
      .eq("id", meeting_id);

    after(async () => {
      try {
        await checkCancelled(meeting_id);

        await updateProgress(meeting_id, "translating");
        const translated = await withRetry(meeting_id, "translating",
          () => step4_translate(inputTurns, config)
        );
        await savePipelineStep(meeting_id, "translated_turns", translated);

        // Cập nhật bảng transcripts với bản dịch mới
        // Match transcript by meeting_id + start_ms (vì TranslatedTurn không có id)
        for (const turn of translated) {
          await supabase
            .from("transcripts")
            .update({
              translated_text: turn.translated_text,
              translation_language: config.targetLanguage,
            })
            .eq("meeting_id", meeting_id)
            .eq("start_ms", turn.start_ms);
        }

        await updateProgress(meeting_id, "completed");
      } catch (error: any) {
        if (error.message !== "CANCELLED") {
          console.error(`[Regenerate Translation Error] Meeting ${meeting_id}:`, error);
          await updateProgress(meeting_id, "failed");
        }
      }
    });

    return NextResponse.json({
      status: "success",
      message: "Đang dịch lại...",
    });
  } catch (error) {
    console.error("Regenerate translation error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
