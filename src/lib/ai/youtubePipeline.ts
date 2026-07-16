// ================================================================
// Tải audio từ YouTube (yt-dlp) rồi chạy pipeline offline.
// Dùng chung cho: route process-youtube (tạo mới) và route resume (Xử lý lại).
// ================================================================

import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runPipeline, updateProgress, PipelineConfig } from "@/lib/ai/pipeline";
import { enqueueAiJobs } from "@/lib/ai/enqueueAiJobs";
import { runAIJobsQueue } from "@/lib/ai/queueWorker";

const execFilePromise = promisify(execFile);

// YouTube yêu cầu JS runtime để giải mã chữ ký format — yt-dlp mặc định chỉ tìm
// deno; máy chạy Node nên chỉ định rõ, thiếu flag này sẽ bị HTTP 403 khi tải.
const YTDLP_COMMON_ARGS = ["--js-runtimes", "node"];

// Exit code của yt-dlp chỉ nói "có lỗi" (1) chứ không nói lý do — lý do thật nằm
// trong stderr. Dịch các pattern phổ biến thành thông báo tiếng Việt dễ hiểu.
function friendlyYtdlpError(stderrTail: string): string {
  const s = stderrTail.toLowerCase();
  if (s.includes("http error 403") || s.includes("forbidden"))
    return "YouTube từ chối yêu cầu tải (lỗi 403 — cơ chế chống bot). Hãy bấm Xử lý lại; nếu vẫn lỗi, cần cập nhật yt-dlp hoặc tải file âm thanh lên trực tiếp.";
  if (s.includes("private video"))
    return "Video ở chế độ riêng tư nên không thể tải.";
  if (s.includes("video unavailable"))
    return "Video không tồn tại hoặc đã bị xóa/ẩn trên YouTube.";
  if (s.includes("sign in to confirm your age") || s.includes("age-restricted") || s.includes("age restricted"))
    return "Video bị giới hạn độ tuổi (yêu cầu đăng nhập YouTube) nên không tải tự động được — hãy tải file âm thanh lên trực tiếp.";
  if (s.includes("members-only") || s.includes("join this channel"))
    return "Video chỉ dành cho hội viên trả phí của kênh (members-only).";
  if (s.includes("not available in your country") || s.includes("geo restriction") || s.includes("blocked it in your"))
    return "Video bị chặn ở khu vực địa lý của bạn.";
  if (s.includes("is a live event") || s.includes("premieres in") || s.includes("live event will begin"))
    return "Video đang phát trực tiếp hoặc chưa công chiếu xong — hãy đợi video kết thúc rồi thử lại.";
  if (s.includes("confirm you're not a bot") || s.includes("confirm you are not a bot"))
    return "YouTube nghi ngờ truy cập tự động và yêu cầu xác minh — hãy thử lại sau ít phút hoặc tải file âm thanh lên trực tiếp.";
  if (s.includes("getaddrinfo") || s.includes("timed out") || s.includes("unable to connect") || s.includes("connection reset"))
    return "Lỗi mạng khi kết nối tới YouTube — kiểm tra internet rồi bấm Xử lý lại.";
  if (s.includes("no supported javascript runtime"))
    return "Máy chủ thiếu JavaScript runtime cho yt-dlp (cần cài Node hoặc Deno).";
  if (s.includes("unsupported url"))
    return "Đường dẫn không phải là video YouTube hợp lệ.";

  // Fallback: lấy dòng ERROR cuối cùng từ stderr, cắt gọn
  const errLine = stderrTail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.toUpperCase().startsWith("ERROR"))
    .pop();
  return errLine
    ? `Tải audio thất bại: ${errLine.replace(/^ERROR:\s*/i, "").slice(0, 160)}`
    : "Tải audio từ YouTube thất bại không rõ nguyên nhân — hãy thử lại hoặc tải file âm thanh lên trực tiếp.";
}

/**
 * Tải audio từ YouTube + chạy full pipeline (bóc băng → process → summary).
 * Tự xử lý lỗi bên trong: set meetings.status = failed kèm message thân thiện.
 * Gọi trong `after()` — không throw ra ngoài.
 */
export async function runYoutubePipeline(
  meetingId: string,
  youtubeUrl: string,
  pipelineConfig: PipelineConfig,
  providedTitle?: string | null
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  try {
    await updateProgress(meetingId, "uploading", undefined, undefined, "Đang tải audio từ YouTube...");

    const ytDlpPath = path.join(process.cwd(), "yt-dlp.exe");

    // Lấy thông tin video bằng yt-dlp
    let videoTitle = providedTitle || "YouTube Video";
    try {
      const { stdout: jsonStdout } = await execFilePromise(ytDlpPath, [
        ...YTDLP_COMMON_ARGS,
        "--dump-json",
        youtubeUrl,
      ]);
      const info = JSON.parse(jsonStdout);
      videoTitle = info.title || videoTitle;
      const durationSeconds = Math.round(info.duration || 0);

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
      if (!providedTitle) {
        await supabase.from("meetings").update({ title: videoTitle }).eq("id", meetingId);
      }

      // Kiểm tra duration (max 4 giờ)
      if (durationSeconds > 4 * 60 * 60) {
        throw new Error(`Video quá dài (${Math.round(durationSeconds / 60)} phút). Giới hạn tối đa là 4 giờ.`);
      }
    } catch (infoError: any) {
      if (infoError.message?.includes("quá dài")) throw infoError;
      console.warn("Cannot get video info via yt-dlp:", infoError.message);
    }

    // Tải audio stream qua stdout bằng yt-dlp
    const child = spawn(ytDlpPath, [
      ...YTDLP_COMMON_ARGS,
      "-f", "ba", // Tải định dạng audio tốt nhất
      "-o", "-",  // Output trực tiếp ra stdout
      youtubeUrl,
    ]);

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    // Giữ đuôi stderr để báo lỗi có ngữ cảnh thay vì chỉ "mã thoát: 1"
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });

    const audioBuffer = await new Promise<Buffer>((resolve, reject) => {
      child.on("close", (code: number) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          const errLine = stderrTail
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.startsWith("ERROR"))
            .pop();
          reject(new Error(`Tải audio thất bại (mã thoát ${code})${errLine ? `: ${errLine}` : ""}`));
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

    await supabase
      .from("meetings")
      .update({
        status: "failed",
        progress: {
          percent: 3,
          stage: "upload",
          message: friendlyMessage,
          updated_at: new Date().toISOString(),
        },
      })
      .eq("id", meetingId);
  }
}
