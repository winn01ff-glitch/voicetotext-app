import { NextResponse, after } from "next/server";
import fs from "fs";
import path from "path";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";
import { runPipeline, PipelineConfig } from "@/lib/ai/pipeline";
import { runYoutubePipeline } from "@/lib/ai/youtubePipeline";

/**
 * Tiếp tục / xử lý lại một cuộc họp bị lỗi/huỷ — retry đúng giai đoạn:
 * - Đã có RAW (raw_deepgram_result) → chỉ chạy lại job process + summary.
 * - Chưa có RAW nhưng còn file audio trên server (public/audio) → chạy lại
 *   từ bước bóc băng (runPipeline) rồi process + summary — giống hệt luồng upload.
 * - Meeting YouTube chưa tải được audio → tải lại từ YouTube rồi chạy full pipeline.
 * - Không có gì để chạy lại → báo lỗi cần tải lại file.
 */
export async function POST(request: Request) {
  try {
    const { meeting_id } = await request.json();
    if (!meeting_id) {
      return NextResponse.json({ error: "Thiếu meeting_id." }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data: meeting, error: fetchError } = await supabase
      .from("meetings")
      .select("status, raw_deepgram_result, title, meeting_context, source_language, target_language, source_type, source_url")
      .eq("id", meeting_id)
      .single();

    if (fetchError || !meeting) {
      return NextResponse.json({ error: "Không tìm thấy cuộc họp." }, { status: 404 });
    }

    if (!["failed", "cancelled"].includes(meeting.status)) {
      return NextResponse.json(
        { error: `Không thể tiếp tục cuộc họp ở trạng thái "${meeting.status}".` },
        { status: 400 }
      );
    }

    // ── Nhánh 1: đã có RAW → chạy lại từ giai đoạn AI ──────────────────────
    if (meeting.raw_deepgram_result) {
      await supabase
        .from("meetings")
        .update({
          status: "processing",
          progress: {
            percent: 35,
            stage: "process",
            message: "Tiếp tục xử lý AI...",
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", meeting_id);

      await enqueueAiJobs(meeting_id, ["process", "summary"]);
      after(() => runAIJobsQueue(meeting_id).catch((err) => console.error("[Resume] Worker error:", err)));

      return NextResponse.json({ status: "success", message: "Đang tiếp tục xử lý AI." });
    }

    // ── Nhánh 2: chưa có RAW → cần bóc băng lại từ nguồn audio ──
    const { data: dbSpeakers } = await supabase
      .from("speakers")
      .select("speaker_tag, display_name, language_code")
      .eq("meeting_id", meeting_id);

    const { data: dbGlossary } = await supabase
      .from("glossary")
      .select("source, target, source_language, target_language")
      .eq("meeting_id", meeting_id);

    const pipelineConfig: PipelineConfig = {
      title: meeting.title || "Meeting",
      meetingContext: meeting.meeting_context || "general",
      sourceLanguage: meeting.source_language || "auto",
      targetLanguage: meeting.target_language,
      speakers: dbSpeakers || [],
      glossary: dbGlossary || [],
    };

    // 2a. Còn file audio trên server → bóc băng lại từ file
    const audioDir = path.join(process.cwd(), "public", "audio");
    let audioFile: string | undefined;
    if (fs.existsSync(audioDir)) {
      audioFile = fs.readdirSync(audioDir).find((f) => f.startsWith(`${meeting_id}.`));
    }

    if (audioFile) {
      const audioBuffer = fs.readFileSync(path.join(audioDir, audioFile));

      await supabase
        .from("meetings")
        .update({
          status: "transcribing",
          progress: {
            percent: 10,
            stage: "transcribe",
            message: "Xử lý lại: đang bóc băng từ file âm thanh...",
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", meeting_id);

      after(async () => {
        try {
          await runPipeline(meeting_id, audioBuffer, pipelineConfig);
          await enqueueAiJobs(meeting_id, ["process", "summary"]);
          await runAIJobsQueue(meeting_id);
        } catch (err) {
          console.error(`[Resume] Re-transcribe pipeline error for ${meeting_id}:`, err);
        }
      });

      return NextResponse.json({ status: "success", message: "Đang xử lý lại từ file âm thanh." });
    }

    // 2b. Meeting YouTube chưa tải được audio → tải lại từ YouTube rồi chạy full pipeline
    if (meeting.source_type === "youtube" && meeting.source_url) {
      await supabase
        .from("meetings")
        .update({
          status: "uploading",
          progress: {
            percent: 3,
            stage: "upload",
            message: "Xử lý lại: đang tải audio từ YouTube...",
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", meeting_id);

      after(() => runYoutubePipeline(meeting_id, meeting.source_url, pipelineConfig, meeting.title || null));

      return NextResponse.json({ status: "success", message: "Đang tải lại audio từ YouTube." });
    }

    return NextResponse.json(
      { error: "Chưa có bản ghi thô từ Deepgram và không còn file âm thanh trên server — hãy tải lại file." },
      { status: 400 }
    );
  } catch (error) {
    console.error("Resume job error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
