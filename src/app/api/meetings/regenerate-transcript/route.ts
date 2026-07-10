import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  PipelineConfig,
  step1_correctSTT,
  step2_speakerMapping,
  step3_consistencyCheck,
  mergeChunks,
  updateProgress,
  savePipelineStep,
  checkCancelled,
  withRetry,
  saveToTables,
} from "@/lib/ai/pipeline";

/**
 * Tạo lại bản ghi (transcript)
 * Đọc raw_deepgram_result từ DB → chạy lại Step 1→2→3
 * KHÔNG gọi lại Deepgram — dùng data đã cache
 */
export async function POST(request: Request) {
  try {
    const { meeting_id } = await request.json();

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

    if (!meeting.raw_deepgram_result) {
      return NextResponse.json(
        { error: "Không có dữ liệu Deepgram để tạo lại. Cần upload lại file âm thanh." },
        { status: 400 }
      );
    }

    // Lấy speakers và glossary mới nhất
    const [{ data: speakers }, { data: glossary }] = await Promise.all([
      supabase.from("speakers").select("*").eq("meeting_id", meeting_id).eq("is_active", true),
      supabase.from("glossary").select("*").eq("meeting_id", meeting_id),
    ]);

    const config: PipelineConfig = {
      title: meeting.title,
      meetingContext: meeting.meeting_context || "general",
      sourceLanguage: meeting.source_language || "auto",
      targetLanguage: meeting.target_language,
      speakers: (speakers || []).map((s: any) => ({
        speaker_tag: s.speaker_tag,
        display_name: s.display_name,
        language_code: s.language_code,
      })),
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
        status: "correcting",
        progress: { percent: 0, message: "Đang tạo lại bản ghi..." },
      })
      .eq("id", meeting_id);

    after(async () => {
      try {
        const deepgramResults = meeting.raw_deepgram_result.chunks;
        const totalChunks = deepgramResults.length;
        const allCorrected: any[] = [];
        const allMapped: any[] = [];
        let previousContext: any[] = [];

        // Step 1-2 từng chunk
        for (let i = 0; i < totalChunks; i++) {
          await checkCancelled(meeting_id);
          const utterances = deepgramResults[i].deepgram_response?.results?.utterances || [];

          await updateProgress(meeting_id, "correcting", i + 1, totalChunks);
          const corrected = await withRetry(meeting_id, "correcting",
            () => step1_correctSTT(utterances, config),
            { chunkIndex: i }
          );
          allCorrected.push(corrected);

          await updateProgress(meeting_id, "diarizing", i + 1, totalChunks);
          const mapped = await withRetry(meeting_id, "diarizing",
            () => step2_speakerMapping(corrected, config, previousContext),
            { chunkIndex: i }
          );
          allMapped.push(mapped);

          previousContext = mapped.slice(-5);
        }

        // Merge
        const mergedTurns = mergeChunks(allMapped, deepgramResults);
        await savePipelineStep(meeting_id, "merged_turns", mergedTurns);

        // Step 3: Consistency Check
        await updateProgress(meeting_id, "checking");
        const checked = await withRetry(meeting_id, "checking",
          () => step3_consistencyCheck(mergedTurns, config)
        );
        await savePipelineStep(meeting_id, "consistency_result", checked);

        // Lưu kết quả vào pipeline_results
        await savePipelineStep(meeting_id, "corrected_turns", allCorrected);
        await savePipelineStep(meeting_id, "speaker_mapping", allMapped);

        await updateProgress(meeting_id, "completed");
      } catch (error: any) {
        if (error.message !== "CANCELLED") {
          console.error(`[Regenerate Transcript Error] Meeting ${meeting_id}:`, error);
          await updateProgress(meeting_id, "failed");
        }
      }
    });

    return NextResponse.json({
      status: "success",
      message: "Đang tạo lại bản ghi...",
    });
  } catch (error) {
    console.error("Regenerate transcript error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
