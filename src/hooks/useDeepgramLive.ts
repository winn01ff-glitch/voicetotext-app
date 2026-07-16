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
  // Bản STT thô 100% cho mỗi final: nguyên văn field `transcript` của Deepgram
  // (đã có dấu câu từ smart_format, KHÔNG dựng lại từ words nên không dính
  // artifact trùng lặp) — dùng cho khung "Nghe trực tiếp".
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
const MAX_RECONNECTS = 5;

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);
  const recordedChunksRef = useRef<Blob[]>([]);
  const archiveStartedRef = useRef<boolean>(false);

  const reconnectCountRef = useRef<number>(0);
  const isIntentionalStop = useRef<boolean>(true);
  // Mốc KẾT THÚC (giây, timestamp thô của connection hiện tại) của từ cuối cùng
  // đã phát ra — dùng để lọc các final bị Deepgram re-emit chồng lấn.
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

  // Request initial mic permission and check status
  const checkMicPermission = useCallback(async () => {
    setStatus("checking_permission");
    onStatusChange("checking_permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission granted, release stream immediately
      stream.getTracks().forEach((track) => track.stop());
      setStatus("preparing");
      onStatusChange("preparing");
      await refreshDevices();
    } catch (err) {
      setStatus("failed");
      onStatusChange("failed");
      onError("Không có quyền truy cập Microphone hoặc thiết bị ghi âm lỗi.");
    }
  }, [refreshDevices, onStatusChange, onError]);

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

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        const isFinal = data.is_final;
        const words = data.channel.alternatives[0].words || [];
        const confidence = data.channel.alternatives[0].confidence || 1.0;
        const speechFinal = data.speech_final || false;
        // Cộng offset để timeline liên tục qua pause/resume/reconnect
        const baseMs = streamBaseMsRef.current;
        // ja, zh, ko không dùng dấu cách làm phân tách từ
        const isNoSpaceLang = ["ja", "zh", "ko"].includes(sourceLanguage || "");
        const joinChar = isNoSpaceLang ? "" : " ";

        // ---- INTERIM (hoặc final không có words): chỉ hiển thị text xám tạm thời,
        // nhãn speaker chưa ổn định nên lấy speaker đa số là đủ ----
        if (!isFinal || words.length === 0) {
          let speakerTag = "speaker_1";
          const speakerCounts: Record<number, number> = {};
          let maxCount = 0;
          for (const word of words) {
            if (typeof word.speaker === "number") {
              speakerCounts[word.speaker] = (speakerCounts[word.speaker] || 0) + 1;
              if (speakerCounts[word.speaker] > maxCount) {
                maxCount = speakerCounts[word.speaker];
                speakerTag = `speaker_${word.speaker + 1}`;
              }
            }
          }
          const startMs = words.length > 0 ? baseMs + Math.round(words[0].start * 1000) : baseMs;
          const endMs = words.length > 0 ? baseMs + Math.round(words[words.length - 1].end * 1000) : baseMs;
          onTranscriptRef.current({
            text: transcript,
            isFinal,
            speechFinal,
            speakerTag,
            startMs,
            endMs,
            confidence,
          });
          return;
        }

        // ---- FINAL ----
        // 1) Loại "mega-word" artifact: với diarize + smart_format trên audio nhiễu
        // (mic thu qua loa), Deepgram đôi khi chèn một "word" mà punctuated_word chứa
        // NGUYÊN CẢ CÂU (vd 20 ký tự trong 0.08s) → dựng text từ words sẽ bị nhân đôi
        // câu. Nhận diện bằng mật độ ký tự phi lý (>50 ký tự/giây và dài >8 ký tự).
        const cleanWords = words.filter((w: any) => {
          const wText = String(w.punctuated_word || w.word || "");
          const dur = Math.max(0.01, (Number(w.end) || 0) - (Number(w.start) || 0));
          return !(wText.length > 8 && wText.length / dur > 50);
        });

        // 2) Lọc re-emission: Deepgram có thể re-emit final chồng lấn lên đoạn đã
        // phát ra trước đó. Từ nào bắt đầu trước mốc KẾT THÚC của từ cuối đã xử lý
        // (trừ dung sai 0.1s cho ranh giới từ) là re-emission → bỏ.
        const filteredWords = cleanWords.filter(
          (w: any) => w.start > lastFinalWordEndRef.current - 0.1
        );
        if (cleanWords.length > 0 && filteredWords.length === 0) {
          // Toàn bộ từ trong segment này đã được xử lý trước đó → cả message là
          // re-emission, bỏ qua (không phát raw để tránh trùng khung nghe trực tiếp)
          return;
        }

        // 3) Bản thô 100% cho khung "Nghe trực tiếp": nguyên văn field transcript
        // (sạch, có dấu câu) — KHÔNG dựng lại từ words.
        onRawFinalRef.current?.(transcript);

        if (filteredWords.length === 0) return;
        const maxEnd = Math.max(...filteredWords.map((w: any) => w.end));
        lastFinalWordEndRef.current = Math.max(lastFinalWordEndRef.current, maxEnd);

        // Một segment final có thể chứa NHIỀU người nói. Cách cũ gán cả segment cho
        // speaker "đa số" khiến lời người này lẫn vào block người kia. Chuẩn xử lý
        // diarization streaming của Deepgram: duyệt words[], cắt thành các RUN liên
        // tiếp cùng word.speaker, mỗi run là một lời thoại riêng.
        // (diarize=false → word không có field speaker → cả segment là 1 run,
        // giữ nguyên hành vi cũ.)
        const runs: { speaker: number; words: any[] }[] = [];
        for (const w of filteredWords) {
          const spk = typeof w.speaker === "number" ? w.speaker : 0;
          const lastRun = runs[runs.length - 1];
          if (lastRun && lastRun.speaker === spk) {
            lastRun.words.push(w);
          } else {
            runs.push({ speaker: spk, words: [w] });
          }
        }

        runs.forEach((run, idx) => {
          const text = run.words
            .map((w: any) => w.punctuated_word || w.word)
            .join(joinChar);
          if (!text.trim()) return;
          onTranscriptRef.current({
            text,
            isFinal: true,
            // speech_final đánh dấu điểm kết thúc của cả segment → chỉ gắn vào run cuối
            speechFinal: speechFinal && idx === runs.length - 1,
            speakerTag: `speaker_${run.speaker + 1}`,
            startMs: baseMs + Math.round(run.words[0].start * 1000),
            endMs: baseMs + Math.round(run.words[run.words.length - 1].end * 1000),
            confidence,
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
          recorder = new MediaRecorder(stream!, { mimeType: "audio/webm;codecs=opus" });
        } catch (e) {
          recorder = new MediaRecorder(stream!);
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
  }, [meetingId, selectedDeviceId, echoCancellation, noiseSuppression, autoGainControl, startVolumeAnalysis, startStreaming, onStatusChange, onError]);

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
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
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
