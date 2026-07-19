import { useState, useEffect, useRef, useCallback } from "react";
import { putAudio, deleteAudio } from "@/lib/audio-cache";

// ================================================================
// Kiến trúc "live để xem + offline để chuẩn":
//
// - ARCHIVE RECORDER: MỘT MediaRecorder chạy liên tục từ đầu tới cuối cuộc họp
//   (pause/resume thay vì stop/start) → xuất ra MỘT file webm hợp lệ duy nhất,
//   chuẩn như file người dùng upload — đây là nguồn cho pipeline offline.
// - STREAM RECORDER: MediaRecorder riêng cho Deepgram live, restart theo từng
//   WebSocket connection (mỗi connection cần webm header mới). Chỉ phục vụ
//   transcript xem realtime, mất mát ở tầng này được bù lại bởi pipeline offline.
//
// Timestamp Deepgram reset về 0 theo từng connection, nên mọi startMs/endMs
// trả về đều được cộng thêm streamBaseMs = tổng thời lượng audio đã ghi trước
// khi connection hiện tại bắt đầu → timeline liên tục qua pause/resume/reconnect.
// ================================================================

interface UseDeepgramLiveProps {
  meetingId: string | null;
  sourceLanguage: string; // 'auto', 'vi', 'en', 'ja'
  glossary?: any[];
  chunkSize: number; // 80 to 150ms
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  endpointing?: number;
  diarize?: boolean;
  onTranscript: (data: {
    text: string;
    isFinal: boolean;
    speechFinal: boolean;
    speakerTag: string;
    startMs: number;
    endMs: number;
    confidence: number;
  }) => void;
  // Raw transcript is emitted once per accepted Deepgram final, independently
  // from the word-level speaker runs used by the diarization UI.
  onRawFinal?: (text: string) => void;
  onActionItemDetected?: (item: { description: string; owner: string; deadline: string | null }) => void;
  onError: (err: string) => void;
  onStatusChange: (status: "idle" | "checking_permission" | "preparing" | "recording" | "processing" | "completed" | "failed") => void;
}

export interface RecordingResult {
  blob: Blob;
  durationMs: number;
}

const ARCHIVE_TIMESLICE_MS = 1000;
// Cố định bitrate archive thay vì nhận default (khác nhau giữa các trình duyệt).
const ARCHIVE_BITRATE_BPS = 128000;
const MAX_RECONNECTS = 5;

interface DeepgramLiveWord {
  word?: string;
  punctuated_word?: string;
  speaker?: number;
  start?: number;
  end?: number;
  confidence?: number;
}

interface SpeakerRun {
  speaker: number;
  words: DeepgramLiveWord[];
}

function wordStart(word: DeepgramLiveWord): number {
  return typeof word.start === "number" ? word.start : 0;
}

function wordEnd(word: DeepgramLiveWord): number {
  return typeof word.end === "number" ? word.end : wordStart(word);
}

function mergeAdjacentSpeakerRuns(runs: SpeakerRun[]): SpeakerRun[] {
  const merged: SpeakerRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous?.speaker === run.speaker) previous.words.push(...run.words);
    else merged.push({ speaker: run.speaker, words: [...run.words] });
  }
  return merged;
}

/**
 * Deepgram diarization is word-level and can briefly flip A -> B -> A inside
 * one uninterrupted sentence. Treat only a single ultra-short, gapless word
 * as noise. Short replies must remain valid speaker turns.
 * A real short reply is preserved when it has an audible boundary or when the
 * speakers on its two sides are different.
 */
function stabilizeSpeakerRuns(runs: SpeakerRun[]): SpeakerRun[] {
  let stable = mergeAdjacentSpeakerRuns(runs);
  let changed = true;

  while (changed && stable.length >= 3) {
    changed = false;
    for (let index = 1; index < stable.length - 1; index += 1) {
      const previous = stable[index - 1];
      const current = stable[index];
      const next = stable[index + 1];
      if (previous.speaker !== next.speaker || current.speaker === previous.speaker) continue;

      const duration = wordEnd(current.words[current.words.length - 1]) - wordStart(current.words[0]);
      const gapBefore = wordStart(current.words[0]) - wordEnd(previous.words[previous.words.length - 1]);
      const gapAfter = wordStart(next.words[0]) - wordEnd(current.words[current.words.length - 1]);
      // Keep this deliberately conservative. Japanese replies are commonly
      // only 1-3 words, so word count alone must never collapse a turn.
      const isShortIsland = current.words.length === 1 && duration <= 0.35;
      const isContinuousSpeech = gapBefore <= 0.08 && gapAfter <= 0.08;

      if (isShortIsland && isContinuousSpeech) {
        current.speaker = previous.speaker;
        stable = mergeAdjacentSpeakerRuns(stable);
        changed = true;
        break;
      }
    }
  }

  return stable;
}

function wordsToTranscript(words: DeepgramLiveWord[], language: string): string {
  const tokens = words.map((w) => w.punctuated_word || w.word || "").filter(Boolean);
  const isCjk = language === "ja" || language === "zh" || language === "ko" ||
    tokens.some((token) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(token));
  if (isCjk) return tokens.join("").trim();
  return tokens.join(" ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

export function useDeepgramLive({
  meetingId,
  sourceLanguage,
  glossary = [],
  chunkSize = 100,
  echoCancellation,
  noiseSuppression,
  autoGainControl,
  endpointing = 3000,
  diarize = true,
  onTranscript,
  onRawFinal,
  onActionItemDetected,
  onError,
  onStatusChange,
}: UseDeepgramLiveProps) {
  const [status, setStatus] = useState<"idle" | "checking_permission" | "preparing" | "recording" | "processing" | "completed" | "failed">("idle");
  const [micLevel, setMicLevel] = useState<number>(0);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const archiveRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRecorderRef = useRef<MediaRecorder | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  // Stream RIÊNG cho archive: tắt echoCancellation/noiseSuppression/AGC để Deepgram
  // batch nhận audio chưa qua WebRTC APM. Null nếu không mở được → archive dùng
  // chung audioStreamRef (hành vi cũ).
  const archiveStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);
  const recordedChunksRef = useRef<Blob[]>([]);
  const archiveStartedRef = useRef<boolean>(false);

  const reconnectCountRef = useRef<number>(0);
  const isIntentionalStop = useRef<boolean>(true);
  const lastFinalWordEndRef = useRef<number>(-1);

  // Đồng hồ audio: tổng ms đã ghi của các đoạn trước + đoạn đang chạy.
  const totalAudioMsRef = useRef<number>(0);
  const segmentStartWallRef = useRef<number | null>(null);
  // Offset cộng vào timestamp Deepgram của connection hiện tại.
  const streamBaseMsRef = useRef<number>(0);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const onRawFinalRef = useRef(onRawFinal);
  useEffect(() => {
    onRawFinalRef.current = onRawFinal;
  }, [onRawFinal]);

  const getCurrentAudioMs = () =>
    totalAudioMsRef.current +
    (segmentStartWallRef.current !== null ? performance.now() - segmentStartWallRef.current : 0);

  // 1. Fetch input audio devices
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      setInputDevices(audioDevices);

      const savedDevice = localStorage.getItem("meeting_device_id");
      if (savedDevice && audioDevices.some(d => d.deviceId === savedDevice)) {
        setSelectedDeviceId(savedDevice);
      } else if (audioDevices.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioDevices[0].deviceId);
      }
    } catch (err) {
      console.error("Enumerate devices error:", err);
    }
  }, [selectedDeviceId]);

  // Kiểm tra quyền mic mà KHÔNG mở mic. getUserMedia dù stop() ngay vẫn bật đèn
  // ghi âm của trình duyệt — người dùng chưa bấm "Bắt đầu" thì không được đụng vào
  // mic. Permissions API chỉ đọc trạng thái quyền, không mở thiết bị.
  // Đánh đổi: khi quyền chưa được cấp, enumerateDevices trả về label rỗng nên danh
  // sách thiết bị trống cho tới lần ghi âm đầu tiên (startRecording refresh lại).
  const checkMicPermission = useCallback(async () => {
    setStatus("checking_permission");
    onStatusChange("checking_permission");

    let granted = false;
    try {
      const perm = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      granted = perm.state === "granted";
    } catch {
      // Safari/trình duyệt cũ không hỗ trợ query 'microphone' — bỏ qua, quyền sẽ
      // được xin đúng lúc bấm "Bắt đầu".
    }

    if (granted) {
      await refreshDevices();
    }

    // "denied" cũng vào preparing thay vì failed: báo lỗi lúc này là báo cho một
    // hành động người dùng chưa yêu cầu. startRecording đã có nhánh lỗi riêng.
    setStatus("preparing");
    onStatusChange("preparing");
  }, [refreshDevices, onStatusChange]);

  // 2. Microphone Level Visualizer
  const startVolumeAnalysis = useCallback((stream: MediaStream) => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    try {
      let audioContext = audioContextRef.current;
      if (!audioContext || audioContext.state === "closed") {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = audioContext;
      } else if (audioContext.state === "suspended") {
        audioContext.resume().catch(err => console.error("AudioContext resume error:", err));
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      let lastDrawTime = 0;
      let currentLevel = 0;

      const draw = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        // Calculate target level and smooth it
        // Noise gate: if average is very low (background hum), ignore it
        let mapped = (average / 128) * 100;
        if (mapped < 15) {
          mapped = 0;
        } else {
          mapped = ((mapped - 15) / 85) * 100;
        }

        const targetLevel = Math.min(100, mapped);
        currentLevel += (targetLevel - currentLevel) * 0.2;

        // Throttle React state updates to ~20fps to prevent lag
        const now = Date.now();
        if (now - lastDrawTime > 50) {
          setMicLevel(Math.round(currentLevel));
          lastDrawTime = now;
        }

        animationFrameRef.current = requestAnimationFrame(draw);
      };

      draw();
    } catch (err) {
      console.error("AudioContext initialization error:", err);
    }
  }, []);

  const stopVolumeAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    setMicLevel(0);
  }, []);

  const releaseMedia = useCallback(() => {
    stopVolumeAnalysis();
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }
    if (archiveStreamRef.current) {
      archiveStreamRef.current.getTracks().forEach((track) => track.stop());
      archiveStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, [stopVolumeAnalysis]);

  // 3. Connect to Deepgram WebSocket
  const connectDeepgram = useCallback(async (): Promise<WebSocket> => {
    const res = await fetch("/api/deepgram-token", { method: "POST" });
    const { token } = await res.json();
    if (!token) throw new Error("Failed to retrieve Deepgram token");

    // Build URL options for Deepgram Live API
    const queryParams = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      filler_words: "true",
      interim_results: "true",
      endpointing: String(endpointing),  // configurable pause before finalizing segment
      diarize: String(diarize),
      // utterance_end_ms: word-timing-gap based turn boundary, robust to background
      // noise that can fool silence-only endpointing. vad_events: exposes voice-activity
      // signals the client can use for finer-grained draft/speaker-turn detection.
      utterance_end_ms: "1000",
      vad_events: "true",
    });

    // Language setting — 'multi' reduces accuracy significantly vs specific language
    const effectiveLang = sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "multi";
    queryParams.set("language", effectiveLang);

    // Glossary → Deepgram keyterm prompting. nova-3 không hỗ trợ tham số `keywords`
    // (chỉ nova-2 trở về trước), và keyterm hiện chỉ hỗ trợ tiếng Anh — các ngôn ngữ
    // khác bỏ qua (glossary vẫn được áp dụng ở bước xử lý Gemini).
    if (effectiveLang === "en" && glossary && glossary.length > 0) {
      for (const item of glossary.slice(0, 100)) {
        const term = typeof item === "string" ? item : (item.term || item.source || item.keyword || "");
        if (term.trim()) {
          queryParams.append("keyterm", term.trim());
        }
      }
    }

    const wsUrl = `wss://api.deepgram.com/v1/listen?${queryParams.toString()}`;
    console.log("[Deepgram WS] Connecting to URL:", wsUrl);
    const ws = new WebSocket(wsUrl, ["token", token]);

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        console.log("[Deepgram WS] WebSocket connected successfully. Flushing audio queue if any...");
        reconnectCountRef.current = 0;
        // Flush queue
        while (audioQueueRef.current.length > 0) {
          const queuedBlob = audioQueueRef.current.shift();
          if (queuedBlob) ws.send(queuedBlob);
        }
        resolve(ws);
      };
      ws.onerror = (err) => {
        console.error("[Deepgram WS] WebSocket connection error:", err);
        reject(err);
      };
    });
  }, [sourceLanguage, endpointing, glossary, diarize]);

  // Dừng hẳn phiên streaming hiện tại (recorder + WebSocket).
  // Queue chunk của phiên cũ bị bỏ: chúng thuộc webm stream cũ, connection mới
  // cần header mới từ recorder mới — đoạn hụt sẽ được pipeline offline bù lại.
  const stopStreaming = useCallback(() => {
    if (streamRecorderRef.current) {
      if (streamRecorderRef.current.state !== "inactive") {
        try { streamRecorderRef.current.stop(); } catch { /* already stopped */ }
      }
      streamRecorderRef.current = null;
    }
    if (webSocketRef.current) {
      const ws = webSocketRef.current;
      webSocketRef.current = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
      }
      try { ws.close(); } catch { /* ignore */ }
    }
    audioQueueRef.current = [];
  }, []);

  const startStreamingRef = useRef<() => void>(() => {});

  const scheduleStreamReconnect = useCallback(() => {
    if (isIntentionalStop.current) return;
    if (reconnectCountRef.current >= MAX_RECONNECTS) {
      setStatus("failed");
      onStatusChange("failed");
      onError("Kết nối WebSocket với Deepgram bị mất và không thể khôi phục.");
      return;
    }
    reconnectCountRef.current++;
    console.warn(`[Deepgram WS] Disconnected. Retrying ${reconnectCountRef.current}/${MAX_RECONNECTS} in 2s...`);
    setTimeout(() => {
      if (!isIntentionalStop.current) {
        startStreamingRef.current();
      }
    }, 2000);
  }, [onError, onStatusChange]);

  // 4. Streaming lên Deepgram — recorder riêng, KHÔNG đụng vào archive recorder.
  const startStreaming = useCallback(() => {
    const stream = audioStreamRef.current;
    if (!stream) return;

    // Không bao giờ để 2 stream recorder chạy song song (kể cả khi reconnect).
    stopStreaming();

    lastFinalWordEndRef.current = -1;
    streamBaseMsRef.current = Math.round(getCurrentAudioMs());

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    } catch (e) {
      console.warn("[MediaRecorder] mimeType 'audio/webm;codecs=opus' not supported, falling back to default recorder options");
      recorder = new MediaRecorder(stream);
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        const ws = webSocketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Flush any buffered chunks first
          while (audioQueueRef.current.length > 0) {
            const queuedBlob = audioQueueRef.current.shift();
            if (queuedBlob) ws.send(queuedBlob);
          }
          ws.send(event.data);
        } else {
          // Queue chunks in memory while connection is warming up
          audioQueueRef.current.push(event.data);
        }
      }
    };

    streamRecorderRef.current = recorder;
    recorder.start(chunkSize);

    connectDeepgram().then((ws) => {
      // Phiên này đã bị thay thế (pause/stop/reconnect khác) trong lúc chờ kết nối
      if (streamRecorderRef.current !== recorder || isIntentionalStop.current) {
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      webSocketRef.current = ws;

      // Xử lý MẶC ĐỊNH của Deepgram — passthrough thuần, không thêm cơ chế nào:
      // dùng nguyên field transcript và nhãn diarization Deepgram trả về.
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const alt = data.channel?.alternatives?.[0];
        const transcript = alt?.transcript;
        if (!transcript) return;

        const words: DeepgramLiveWord[] = alt.words || [];
        // baseMs: offset hạ tầng để timestamp liên tục qua pause/resume.
        const baseMs = streamBaseMsRef.current;

        // Interim chỉ phục vụ preview, giữ nguyên transcript để tránh UI nhảy qua
        // lại giữa nhiều speaker khi Deepgram còn đang sửa giả thuyết.
        if (!data.is_final || words.length === 0) {
          const speaker = typeof words[0]?.speaker === "number" ? words[0].speaker : 0;
          const lastWord = words[words.length - 1];
          onTranscriptRef.current({
            text: transcript,
            isFinal: !!data.is_final,
            speechFinal: !!data.speech_final,
            speakerTag: `speaker_${speaker + 1}`,
            startMs: typeof words[0]?.start === "number" ? baseMs + Math.round(words[0].start * 1000) : baseMs,
            endMs: typeof lastWord?.end === "number" ? baseMs + Math.round(lastWord.end * 1000) : baseMs,
            confidence: alt.confidence || 1.0,
          });
          return;
        }

        // Deepgram đôi khi chèn một word chứa nguyên cả câu trong vài chục ms.
        // Nếu dựng text từ word đó, câu sẽ bị nhân đôi. Loại artifact có mật độ
        // ký tự phi lý trước khi tách speaker runs.
        const cleanWords = words.filter((word) => {
          const wordText = String(word.punctuated_word || word.word || "");
          const duration = Math.max(0.01, (Number(word.end) || 0) - (Number(word.start) || 0));
          return !(wordText.length > 8 && wordText.length / duration > 50);
        });

        // Final/correction có thể chồng lên final đã phát trước đó. Chỉ giữ các
        // word nằm sau mốc cuối đã chấp nhận; nếu cả message là re-emission thì
        // bỏ hoàn toàn, bao gồm cả raw transcript.
        const filteredWords = cleanWords.filter((word) => {
          if (lastFinalWordEndRef.current < 0) return true;
          if (typeof word.end === "number") return word.end > lastFinalWordEndRef.current + 0.02;
          return typeof word.start !== "number" || word.start > lastFinalWordEndRef.current + 0.02;
        });
        if (cleanWords.length > 0 && filteredWords.length === 0) return;
        if (filteredWords.length === 0) return;

        const finalEnds = filteredWords
          .map((word) => word.end)
          .filter((value): value is number => typeof value === "number");
        if (finalEnds.length > 0) {
          lastFinalWordEndRef.current = Math.max(lastFinalWordEndRef.current, ...finalEnds);
        }

        // Raw is emitted exactly once per accepted final. Speaker-run callbacks
        // below must never append to the raw listening panel themselves.
        const rawText = filteredWords.length === cleanWords.length
          ? transcript
          : wordsToTranscript(filteredWords, sourceLanguage);
        if (rawText) onRawFinalRef.current?.(rawText);

        // Một final result có thể chứa NHIỀU người nói. Trước đây toàn bộ result
        // bị gán theo words[0].speaker, làm câu trả lời của người sau dính sang
        // người trước. Tách thành các run liên tiếp theo word.speaker và giữ
        // timestamp thật của từng run trước khi đưa sang UI/Gemini.
        const rawRuns: SpeakerRun[] = [];
        for (const word of filteredWords) {
          const speaker = typeof word.speaker === "number"
            ? word.speaker
            : (rawRuns[rawRuns.length - 1]?.speaker ?? 0);
          const current = rawRuns[rawRuns.length - 1];
          if (current && current.speaker === speaker) current.words.push(word);
          else rawRuns.push({ speaker, words: [word] });
        }

        const runs = stabilizeSpeakerRuns(rawRuns);

        runs.forEach((run, index) => {
          const runText = wordsToTranscript(run.words, sourceLanguage);
          if (!runText) return;
          const confidences = run.words
            .map((word) => word.confidence)
            .filter((value): value is number => typeof value === "number");
          onTranscriptRef.current({
            text: runText,
            isFinal: true,
            speechFinal: !!data.speech_final && index === runs.length - 1,
            speakerTag: `speaker_${run.speaker + 1}`,
            startMs: baseMs + Math.round((run.words[0].start || 0) * 1000),
            endMs: baseMs + Math.round((run.words[run.words.length - 1].end || 0) * 1000),
            confidence: confidences.length > 0
              ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
              : (alt.confidence || 1.0),
          });
        });
      };

      ws.onclose = (event) => {
        console.log(`[Deepgram WS] Connection closed. Code: ${event.code}, Reason: ${event.reason || "None"}`);
        if (webSocketRef.current === ws) {
          webSocketRef.current = null;
        }
        scheduleStreamReconnect();
      };
    }).catch((err) => {
      console.error("[Deepgram WS] Connection failed in background:", err);
      if (streamRecorderRef.current === recorder) {
        scheduleStreamReconnect();
      }
    });
  }, [stopStreaming, connectDeepgram, chunkSize, sourceLanguage, scheduleStreamReconnect]);

  useEffect(() => {
    startStreamingRef.current = startStreaming;
  }, [startStreaming]);

  // 5. Start / resume recording
  const startRecording = useCallback(async () => {
    if (!meetingId) {
      onError("Cuộc họp chưa được khởi tạo.");
      return;
    }
    // Chống double-start
    if (archiveRecorderRef.current && archiveRecorderRef.current.state === "recording") {
      return;
    }

    isIntentionalStop.current = false;
    reconnectCountRef.current = 0;
    setStatus("recording");
    onStatusChange("recording");

    // 1. Lấy hoặc tái sử dụng mic stream
    let stream = audioStreamRef.current;
    const streamAlive = !!stream && stream.getAudioTracks().some((t) => t.readyState === "live");
    if (!streamAlive) {
      try {
        console.log("[Deepgram WS] Getting microphone stream...");
        const constraints: MediaStreamConstraints = {
          audio: {
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
            echoCancellation,
            noiseSuppression,
            autoGainControl,
          },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        audioStreamRef.current = stream;
        // Lần đầu được cấp quyền: giờ enumerateDevices mới trả về label thật.
        if (inputDevices.length === 0) {
          refreshDevices().catch(() => {});
        }
      } catch (err) {
        console.error("[MediaRecorder] Microphone access failed:", err);
        setStatus("failed");
        onStatusChange("failed");
        onError("Không thể truy cập Microphone. Vui lòng kiểm tra quyền thiết bị.");
        return;
      }
    }
    stream!.getAudioTracks().forEach((t) => (t.enabled = true));
    startVolumeAnalysis(stream!);

    // 1b. Stream RAW cho archive — cùng mic, nhưng tắt toàn bộ xử lý của trình duyệt.
    // Noise suppression hay cắt cụt phụ âm xát (s/sh/f/th) và AGC làm méo khi nhiều
    // người nói chồng; Deepgram nova-3 tự khử nhiễu tốt hơn trên audio chưa xử lý.
    // Không mở được (thiết bị không cho mở 2 capture session) → fallback dùng chung
    // stream đã xử lý, đúng như hành vi trước đây.
    let archiveStream = archiveStreamRef.current;
    const archiveAlive =
      !!archiveStream && archiveStream.getAudioTracks().some((t) => t.readyState === "live");
    if (!archiveAlive) {
      try {
        archiveStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        archiveStreamRef.current = archiveStream;
      } catch (err) {
        console.warn(
          "[MediaRecorder] Raw archive stream unavailable, falling back to the processed stream:",
          err
        );
        archiveStream = null;
        archiveStreamRef.current = null;
      }
    }
    const archiveSource = archiveStream ?? stream!;
    archiveSource.getAudioTracks().forEach((t) => (t.enabled = true));

    // 2. Archive recorder — MỘT file webm liên tục cho cả cuộc họp
    try {
      const archive = archiveRecorderRef.current;
      if (archive && archive.state === "paused") {
        archive.resume();
      } else if (!archive || archive.state === "inactive") {
        if (!archiveStartedRef.current) {
          recordedChunksRef.current = [];
          totalAudioMsRef.current = 0;
          archiveStartedRef.current = true;
        }
        // Nếu recorder cũ đã chết bất thường (stream bị ngắt), chunks cũ vẫn được
        // giữ lại — file sẽ đa-segment (degraded) nhưng không mất audio.
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(archiveSource, {
            mimeType: "audio/webm;codecs=opus",
            audioBitsPerSecond: ARCHIVE_BITRATE_BPS,
          });
        } catch (e) {
          recorder = new MediaRecorder(archiveSource);
        }
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };
        archiveRecorderRef.current = recorder;
        recorder.start(ARCHIVE_TIMESLICE_MS);
      }
    } catch (err) {
      console.error("[MediaRecorder] Recording startup failed:", err);
      setStatus("failed");
      onStatusChange("failed");
      onError("Lỗi khởi tạo bộ ghi âm.");
      return;
    }
    segmentStartWallRef.current = performance.now();

    // 3. Streaming lên Deepgram (recorder riêng)
    console.log("[Deepgram WS] Establishing Deepgram connection in background...");
    startStreaming();
  }, [meetingId, selectedDeviceId, echoCancellation, noiseSuppression, autoGainControl, inputDevices.length, refreshDevices, startVolumeAnalysis, startStreaming, onStatusChange, onError]);

  // 6. Pause recording
  const pauseRecording = useCallback(() => {
    isIntentionalStop.current = true;
    stopStreaming();

    if (archiveRecorderRef.current && archiveRecorderRef.current.state === "recording") {
      try { archiveRecorderRef.current.pause(); } catch { /* ignore */ }
    }
    if (segmentStartWallRef.current !== null) {
      totalAudioMsRef.current += performance.now() - segmentStartWallRef.current;
      segmentStartWallRef.current = null;
    }

    // Giữ stream sống (chỉ disable track) để archive recorder resume được và file
    // webm cuối cùng vẫn là MỘT container hợp lệ. Đánh đổi: mic vẫn bị trình duyệt
    // giữ trong lúc tạm dừng (track disabled → không thu âm thanh).
    if (audioStreamRef.current) {
      audioStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    if (archiveStreamRef.current) {
      archiveStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    stopVolumeAnalysis();

    // Cache tạm phần audio đã ghi để phục hồi nếu crash giữa chừng
    if (recordedChunksRef.current.length > 0 && meetingId) {
      const partialBlob = new Blob(recordedChunksRef.current, { type: "audio/webm;codecs=opus" });
      putAudio(meetingId, partialBlob).catch((err) => {
        console.error("Failed to save partial audio blob to cache:", err);
      });
    }

    setStatus("preparing");
    onStatusChange("preparing");
  }, [meetingId, stopStreaming, stopVolumeAnalysis, onStatusChange]);

  // 7. Stop recording — trả về blob audio hoàn chỉnh (đã đợi chunk cuối flush xong)
  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    isIntentionalStop.current = true;
    stopStreaming();

    if (segmentStartWallRef.current !== null) {
      totalAudioMsRef.current += performance.now() - segmentStartWallRef.current;
      segmentStartWallRef.current = null;
    }

    // Đợi onstop để MediaRecorder flush chunk cuối cùng vào recordedChunksRef
    const archive = archiveRecorderRef.current;
    if (archive && archive.state !== "inactive") {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        archive.onstop = finish;
        setTimeout(finish, 2000); // safety net nếu onstop không bao giờ bắn
        try { archive.stop(); } catch { finish(); }
      });
    }
    archiveRecorderRef.current = null;
    archiveStartedRef.current = false;

    releaseMedia();

    let result: RecordingResult | null = null;
    if (recordedChunksRef.current.length > 0) {
      const audioBlob = new Blob(recordedChunksRef.current, { type: "audio/webm;codecs=opus" });
      result = { blob: audioBlob, durationMs: Math.round(totalAudioMsRef.current) };

      // Lưu cache IndexedDB (sống qua reload, mất khi đóng trình duyệt) — caller
      // nên dùng blob trả về trực tiếp, cache chỉ là fallback phục hồi.
      if (meetingId) {
        putAudio(meetingId, audioBlob)
          .then(() => {
            console.log("[useDeepgramLive] Saved audio cache to IndexedDB for meeting:", meetingId);
          })
          .catch((err) => {
            console.error("Failed to save audio blob to cache:", err);
          });
      }
    }

    setStatus("processing");
    onStatusChange("processing");
    return result;
  }, [meetingId, stopStreaming, releaseMedia, onStatusChange]);

  // 8. Discard recording — hủy toàn bộ audio đã ghi (dùng khi "Bắt đầu lại")
  const discardRecording = useCallback(async () => {
    isIntentionalStop.current = true;
    stopStreaming();

    if (archiveRecorderRef.current) {
      if (archiveRecorderRef.current.state !== "inactive") {
        try { archiveRecorderRef.current.stop(); } catch { /* ignore */ }
      }
      archiveRecorderRef.current = null;
    }
    archiveStartedRef.current = false;
    recordedChunksRef.current = [];
    totalAudioMsRef.current = 0;
    segmentStartWallRef.current = null;
    streamBaseMsRef.current = 0;
    lastFinalWordEndRef.current = -1;

    releaseMedia();

    if (meetingId) {
      try {
        await deleteAudio(meetingId);
      } catch (err) {
        console.warn("[useDeepgramLive] Failed to delete cached audio:", err);
      }
    }

    setStatus("preparing");
    onStatusChange("preparing");
  }, [meetingId, stopStreaming, releaseMedia, onStatusChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isIntentionalStop.current = true;
      if (streamRecorderRef.current && streamRecorderRef.current.state !== "inactive") {
        try { streamRecorderRef.current.stop(); } catch { /* ignore */ }
      }
      if (archiveRecorderRef.current && archiveRecorderRef.current.state !== "inactive") {
        try { archiveRecorderRef.current.stop(); } catch { /* ignore */ }
      }
      if (webSocketRef.current) {
        webSocketRef.current.close();
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
      }
      if (archiveStreamRef.current) {
        archiveStreamRef.current.getTracks().forEach((track) => track.stop());
        archiveStreamRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      analyserRef.current = null;
      // close() trên AudioContext đã đóng trả về promise bị reject → unhandled
      // rejection ("Cannot close a closed AudioContext"). Chặn cả hai đầu: kiểm tra
      // state trước, và catch phần còn lại. Null ref để lần mount sau không kế thừa
      // context chết (Fast Refresh / StrictMode chạy cleanup rồi mount lại).
      if (audioContextRef.current) {
        if (audioContextRef.current.state !== "closed") {
          audioContextRef.current.close().catch(() => {});
        }
        audioContextRef.current = null;
      }
    };
  }, []);

  return {
    status,
    micLevel,
    inputDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    checkMicPermission,
    startRecording,
    pauseRecording,
    stopRecording,
    discardRecording,
    setStatus,
  };
}
