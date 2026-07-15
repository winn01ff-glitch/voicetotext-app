import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runPipeline, PipelineConfig } from "@/lib/ai/pipeline";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";

/**
 * Xử lý YouTube URL
 * Tạo meeting → return meetingId → after() tải audio + chạy pipeline
 * 
 * Lưu ý: Cần cài thêm @distube/ytdl-core để tải audio từ YouTube
 * npm install @distube/ytdl-core
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { youtube_url, title, source_language, target_language, meeting_context, speakers, glossary } = body;

    if (!youtube_url) {
      return NextResponse.json(
        { error: "Thiếu đường dẫn YouTube." },
        { status: 400 }
      );
    }

    if (!target_language) {
      return NextResponse.json(
        { error: "Thiếu ngôn ngữ dịch đích." },
        { status: 400 }
      );
    }

    // Validate YouTube URL
    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/;
    if (!ytRegex.test(youtube_url)) {
      return NextResponse.json(
        { error: "Đường dẫn YouTube không hợp lệ." },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();

    // Tạo meeting (status = queued)
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        title: title || "YouTube Video",
        status: "queued",
        source_language: source_language || "auto",
        target_language,
        meeting_context: meeting_context || "general",
        source_type: "youtube",
        source_url: youtube_url,
        progress: { percent: 0, message: "Đang chờ xử lý..." },
      })
      .select()
      .single();

    if (meetingError) throw meetingError;

    const meetingId = meeting.id;

    // Tạo speakers
    const defaultColors = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
    if (speakers && speakers.length > 0) {
      const speakersToInsert = speakers.map((sp: any, idx: number) => ({
        meeting_id: meetingId,
        speaker_tag: sp.speaker_tag,
        display_name: sp.display_name || `Speaker ${idx}`,
        language_code: sp.language_code || "auto",
        color_hex: sp.color_hex || defaultColors[idx % defaultColors.length],
      }));

      await supabase.from("speakers").insert(speakersToInsert);
    }

    // Tạo glossary
    if (glossary && glossary.length > 0) {
      const glossaryToInsert = glossary.map((g: any) => ({
        meeting_id: meetingId,
        source: g.source,
        target: g.target,
        source_language: g.source_language || "auto",
        target_language: g.target_language || target_language,
      }));

      await supabase.from("glossary").insert(glossaryToInsert);
    }

    // Tạo draft AI summary
    await supabase.from("ai_summaries").insert({
      meeting_id: meetingId,
      status: "Draft",
      executive_summary: "",
      decisions: [],
    });

    // Tạo meeting_metadata
    await supabase.from("meeting_metadata").insert({
      meeting_id: meetingId,
      created_from: "youtube",
    });

    // Pipeline config
    const pipelineConfig: PipelineConfig = {
      title: title || "YouTube Video",
      meetingContext: meeting_context || "general",
      sourceLanguage: source_language || "auto",
      targetLanguage: target_language,
      speakers: speakers || [],
      glossary: glossary || [],
    };

    // Background: tải audio từ YouTube rồi chạy pipeline
    after(async () => {
      try {
        const { updateProgress } = await import("@/lib/ai/pipeline");

        await updateProgress(meetingId, "uploading");

        const { execFile, spawn } = require("child_process");
        const path = require("path");
        const util = require("util");
        const execFilePromise = util.promisify(execFile);
        const ytDlpPath = path.join(process.cwd(), "yt-dlp.exe");

        // Lấy thông tin video bằng yt-dlp
        let videoTitle = title || "YouTube Video";
        let durationSeconds = 0;
        try {
          const { stdout: jsonStdout } = await execFilePromise(ytDlpPath, [
            "--dump-json",
            youtube_url
          ]);
          const info = JSON.parse(jsonStdout);
          videoTitle = info.title || videoTitle;
          durationSeconds = Math.round(info.duration || 0);

          // Cập nhật metadata
          await supabase
            .from("meeting_metadata")
            .update({
              duration_seconds: durationSeconds,
              youtube_title: videoTitle,
              youtube_thumbnail_url: info.thumbnail || info.thumbnails?.[0]?.url,
            })
            .eq("meeting_id", meetingId);

          // Cập nhật title nếu chưa có
          if (!title) {
            await supabase
              .from("meetings")
              .update({ title: videoTitle })
              .eq("id", meetingId);
          }

          // Kiểm tra duration (max 4 giờ)
          if (durationSeconds > 4 * 60 * 60) {
            throw new Error(`Video quá dài (${Math.round(durationSeconds / 60)} phút). Giới hạn tối đa là 4 giờ.`);
          }
        } catch (infoError: any) {
          if (infoError.message.includes("quá dài")) throw infoError;
          console.warn("Cannot get video info via yt-dlp:", infoError.message);
        }

        // Tải audio stream qua stdout bằng yt-dlp
        const child = spawn(ytDlpPath, [
          "-f", "ba", // Tải định dạng audio tốt nhất
          "-o", "-",  // Output trực tiếp ra stdout
          youtube_url
        ]);

        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        const audioBuffer = await new Promise<Buffer>((resolve, reject) => {
          child.on("close", (code: number) => {
            if (code === 0) {
              resolve(Buffer.concat(chunks));
            } else {
              reject(new Error(`Tải audio thất bại, mã thoát: ${code}`));
            }
          });
          child.on("error", (err: Error) => {
            reject(err);
          });
        });

        // Cập nhật file size
        await supabase
          .from("meeting_metadata")
          .update({ file_size_bytes: audioBuffer.length })
          .eq("meeting_id", meetingId);

        // Lưu cache âm thanh YouTube vào thư mục public/audio để client tải về phát lại
        try {
          const fs = require("fs");
          const audioDir = path.join(process.cwd(), "public", "audio");
          if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
          }
          const audioPath = path.join(audioDir, `${meetingId}.webm`);
          fs.writeFileSync(audioPath, audioBuffer);
          console.log(`[YouTube Process] Saved audio cache to: ${audioPath}`);
        } catch (saveErr) {
          console.error("[YouTube Process] Failed to save audio file to disk:", saveErr);
        }

        // Bóc băng → RAW blob, rồi xử lý AI hợp nhất + tóm tắt.
        await runPipeline(meetingId, audioBuffer, pipelineConfig);
        await enqueueAiJobs(meetingId, ["process", "summary"]);
        await runAIJobsQueue(meetingId);
      } catch (error: any) {
        console.error(`[YouTube Pipeline Error] Meeting ${meetingId}:`, error);
        
        let friendlyMessage = "Lỗi khi tải hoặc xử lý video YouTube.";
        const errMsg = error?.message || "";
        
        if (
          errMsg.includes("403") || 
          errMsg.includes("decipher") || 
          errMsg.includes("transform") || 
          errMsg.includes("player-script") ||
          errMsg.includes("status code")
        ) {
          friendlyMessage = "Không thể tải video từ YouTube (YouTube chặn kết nối tự động. Vui lòng tải file âm thanh lên trực tiếp).";
        } else if (errMsg.includes("length") || errMsg.includes("quá dài") || errMsg.includes("Tải audio thất bại")) {
          friendlyMessage = errMsg;
        } else if (errMsg) {
          friendlyMessage = `Lỗi xử lý: ${errMsg}`;
        }

        const supabase2 = await createServerSupabaseClient();
        await supabase2
          .from("meetings")
          .update({
            status: "failed",
            progress: { percent: 0, message: friendlyMessage },
          })
          .eq("id", meetingId);
      }
    });

    return NextResponse.json({
      status: "success",
      meeting_id: meetingId,
    });
  } catch (error) {
    console.error("Process YouTube error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
