import { useState, useEffect, useRef, useCallback } from "react";

interface SpeakerInfo {
  speaker_tag: string;
  display_name: string;
  language_code: string;
  color_hex: string;
}

interface UseDeepgramLiveProps {
  meetingId: string | null;
  sourceLanguage: string; // 'auto', 'vi', 'en', 'ja'
  glossary?: any[];
  chunkSize: number; // 80 to 150ms
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  onTranscript: (data: {
    text: string;
    isFinal: boolean;
    speechFinal: boolean;
    speakerTag: string;
    startMs: number;
    endMs: number;
    confidence: number;
  }) => void;
  onActionItemDetected?: (item: { description: string; owner: string; deadline: string | null }) => void;
  onError: (err: string) => void;
  onStatusChange: (status: "idle" | "checking_permission" | "preparing" | "recording" | "processing" | "completed" | "failed") => void;
}

export function useDeepgramLive({
  meetingId,
  sourceLanguage,
  glossary = [],
  chunkSize = 100,
  echoCancellation,
  noiseSuppression,
  autoGainControl,
  onTranscript,
  onActionItemDetected,
  onError,
  onStatusChange,
}: UseDeepgramLiveProps) {
  const [status, setStatus] = useState<"idle" | "checking_permission" | "preparing" | "recording" | "processing" | "completed" | "failed">("idle");
  const [micLevel, setMicLevel] = useState<number>(0);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);

  const reconnectCountRef = useRef<number>(0);
  const maxReconnects = 5;
  const isIntentionalStop = useRef<boolean>(false);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

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

  // Initialize preview stream removed to prevent mic being active when not recording.


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
      endpointing: "3000",  // 3s pause before finalizing segment
      diarize: "true",
    });

    // Language setting — 'multi' reduces accuracy significantly vs specific language
    if (sourceLanguage && sourceLanguage !== "auto") {
      queryParams.set("language", sourceLanguage);
    } else {
      queryParams.set("language", "multi");
    }

    // Send glossary terms as Deepgram keywords for better recognition accuracy
    if (glossary && glossary.length > 0) {
      for (const item of glossary.slice(0, 100)) { // Max 100 keywords
        const term = typeof item === "string" ? item : (item.term || item.source || item.keyword || "");
        if (term.trim()) {
          queryParams.append("keywords", term.trim());
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
  }, [sourceLanguage]);

  // 4. Start recording and streaming
  const startRecording = useCallback(async () => {
    if (!meetingId) {
      onError("Cuộc họp chưa được khởi tạo.");
      return;
    }
    isIntentionalStop.current = false;
    audioQueueRef.current = []; // Clear any residual queue
    setStatus("recording");
    onStatusChange("recording");

    let stream: MediaStream;
    try {
      // 1. Instantly capture microphone stream to begin recording with zero lag
      console.log("[Deepgram WS] Getting microphone stream...");
      const constraints: MediaStreamConstraints = {
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
      };
      
      stream = audioStreamRef.current 
        ? audioStreamRef.current 
        : await navigator.mediaDevices.getUserMedia(constraints);
        
      audioStreamRef.current = stream;
      startVolumeAnalysis(stream);
    } catch (err) {
      console.error("[MediaRecorder] Microphone access failed:", err);
      setStatus("failed");
      onStatusChange("failed");
      onError("Không thể truy cập Microphone. Vui lòng kiểm tra quyền thiết bị.");
      return;
    }

    try {
      // 2. Initialize and start MediaRecorder instantly to prevent any lost words
      const options = { mimeType: "audio/webm;codecs=opus" };
      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e) {
        console.warn("[MediaRecorder] mimeType 'audio/webm;codecs=opus' not supported, falling back to default recorder options");
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
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

      console.log(`[MediaRecorder] Starting recorder with timeslice: ${chunkSize}ms`);
      mediaRecorder.start(chunkSize);

      // 3. Connect to Deepgram WebSocket asynchronously in the background
      console.log("[Deepgram WS] Establishing Deepgram connection in background...");
      connectDeepgram().then((ws) => {
        webSocketRef.current = ws;

        // Setup WebSocket event handlers
        ws.onmessage = async (event) => {
          const data = JSON.parse(event.data);
          const transcript = data.channel?.alternatives?.[0]?.transcript;

          if (transcript) {
            const isFinal = data.is_final;
            const words = data.channel.alternatives[0].words || [];
            
            // Calculate predominant speaker tag
            let speakerTag = "speaker_1";
            if (words.length > 0) {
              const speakerCounts: Record<number, number> = {};
              let maxCount = 0;
              let predominantSpeaker = 0;

              for (const word of words) {
                if (typeof word.speaker === "number") {
                  speakerCounts[word.speaker] = (speakerCounts[word.speaker] || 0) + 1;
                  if (speakerCounts[word.speaker] > maxCount) {
                    maxCount = speakerCounts[word.speaker];
                    predominantSpeaker = word.speaker;
                  }
                }
              }
              speakerTag = `speaker_${predominantSpeaker + 1}`;
            }

            let startMs = 0;
            let endMs = 0;
            if (words.length > 0) {
              startMs = Math.round(words[0].start * 1000);
              endMs = Math.round(words[words.length - 1].end * 1000);
            }

            const confidence = data.channel.alternatives[0].confidence || 1.0;

            onTranscriptRef.current({
              text: transcript,
              isFinal,
              speechFinal: data.speech_final || false,
              speakerTag,
              startMs,
              endMs,
              confidence,
            });
          }
        };

        ws.onclose = (event) => {
          console.log(`[Deepgram WS] Connection closed. Code: ${event.code}, Reason: ${event.reason || "None"}`);
          if (!isIntentionalStop.current && reconnectCountRef.current < maxReconnects) {
            reconnectCountRef.current++;
            console.warn(`WebSocket disconnected. Retrying reconnection ${reconnectCountRef.current}/${maxReconnects} in 2s...`);
            setTimeout(() => {
              startRecording();
            }, 2000);
          } else if (!isIntentionalStop.current) {
            setStatus("failed");
            onStatusChange("failed");
            onError("Kết nối WebSocket với Deepgram bị mất và không thể khôi phục.");
          }
        };
      }).catch((err) => {
        console.error("[Deepgram WS] Connection failed in background:", err);
        onError("Không thể kết nối đến máy chủ Deepgram.");
      });

    } catch (err) {
      console.error("[MediaRecorder] Recording startup failed:", err);
      setStatus("failed");
      onStatusChange("failed");
      onError("Lỗi khởi tạo bộ ghi âm.");
    }
  }, [meetingId, selectedDeviceId, echoCancellation, noiseSuppression, autoGainControl, chunkSize, connectDeepgram, startVolumeAnalysis, onTranscript, onStatusChange, onError]);

  // 5. Pause recording
  const pauseRecording = useCallback(() => {
    isIntentionalStop.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (webSocketRef.current) {
      if (webSocketRef.current.readyState === WebSocket.OPEN) {
        webSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      webSocketRef.current.close();
      webSocketRef.current = null;
    }
    
    // Stop mic stream completely when paused
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }
    
    setMicLevel(0);
    setStatus("preparing");
    onStatusChange("preparing");
  }, [onStatusChange]);

  // 6. Stop recording
  const stopRecording = useCallback(() => {
    isIntentionalStop.current = true;
    
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }

    if (webSocketRef.current) {
      if (webSocketRef.current.readyState === WebSocket.OPEN) {
        // Send closing metadata
        webSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      webSocketRef.current.close();
      webSocketRef.current = null;
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setMicLevel(0);
    setStatus("processing");
    onStatusChange("processing");
  }, [onStatusChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isIntentionalStop.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
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
    setStatus,
  };
}
