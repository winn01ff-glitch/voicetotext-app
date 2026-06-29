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
  chunkSize: number; // 80 to 150ms
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  onTranscript: (data: {
    text: string;
    isFinal: boolean;
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

  const reconnectCountRef = useRef<number>(0);
  const maxReconnects = 5;
  const isIntentionalStop = useRef<boolean>(false);

  // 1. Fetch input audio devices
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      setInputDevices(audioDevices);
      if (audioDevices.length > 0 && !selectedDeviceId) {
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
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      // Map to 0-100 scale
      const mappedVal = Math.min(100, Math.round((average / 128) * 100));
      setMicLevel(mappedVal);

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
  }, []);

  // Initialize preview stream (for test mic level in preparing state)
  const initPreviewStream = useCallback(async (deviceId: string) => {
    try {
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      audioStreamRef.current = stream;
      startVolumeAnalysis(stream);
    } catch (err) {
      console.error("Preview stream error:", err);
      onError("Không thể kết nối thiết bị microphone đã chọn.");
    }
  }, [echoCancellation, noiseSuppression, autoGainControl, startVolumeAnalysis, onError]);

  useEffect(() => {
    if (status === "preparing" && selectedDeviceId) {
      initPreviewStream(selectedDeviceId);
    }
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [status, selectedDeviceId, initPreviewStream]);

  // 3. Connect to Deepgram WebSocket
  const connectDeepgram = useCallback(async (): Promise<WebSocket> => {
    const res = await fetch("/api/deepgram-token", { method: "POST" });
    const { token } = await res.json();
    if (!token) throw new Error("Failed to retrieve Deepgram token");

    // Build URL options for Deepgram Live API
    const queryParams = new URLSearchParams({
      model: "nova-2",
      smart_format: "true",
      diarize: "true",
      interim_results: "true",
    });

    if (sourceLanguage !== "auto") {
      queryParams.set("language", sourceLanguage);
    }

    const wsUrl = `wss://api.deepgram.com/v1/listen?${queryParams.toString()}`;
    const ws = new WebSocket(wsUrl, ["token", token]);

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        console.log("Deepgram WS connected");
        reconnectCountRef.current = 0;
        resolve(ws);
      };
      ws.onerror = (err) => {
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
    setStatus("recording");
    onStatusChange("recording");

    try {
      // Connect Deepgram WebSocket
      const ws = await connectDeepgram();
      webSocketRef.current = ws;

      // Ensure audio stream is active (use selected device constraints)
      if (!audioStreamRef.current) {
        const constraints: MediaStreamConstraints = {
          audio: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            echoCancellation,
            noiseSuppression,
            autoGainControl,
          },
        };
        audioStreamRef.current = await navigator.mediaDevices.getUserMedia(constraints);
      }

      startVolumeAnalysis(audioStreamRef.current);

      // Start MediaRecorder (sending raw audio bytes to WebSocket)
      const options = { mimeType: "audio/webm;codecs=opus" };
      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(audioStreamRef.current, options);
      } catch (e) {
        // Fallback if mimeType is not supported on this browser
        mediaRecorder = new MediaRecorder(audioStreamRef.current);
      }

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      };

      // Start capturing in chunks (configurable chunk size, e.g. 100ms)
      mediaRecorder.start(chunkSize);

      // Setup WebSocket event handlers
      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;

        if (transcript) {
          const isFinal = data.is_final;
          const words = data.channel.alternatives[0].words || [];
          
          // Determine speaker tag
          let speakerTag = "speaker_0";
          if (words.length > 0 && typeof words[0].speaker === "number") {
            speakerTag = `speaker_${words[0].speaker}`;
          }

          // Calculate start_ms and end_ms
          let startMs = 0;
          let endMs = 0;
          if (words.length > 0) {
            startMs = Math.round(words[0].start * 1000);
            endMs = Math.round(words[words.length - 1].end * 1000);
          }

          const confidence = data.channel.alternatives[0].confidence || 1.0;

          // Push transcript event to parent UI
          onTranscript({
            text: transcript,
            isFinal,
            speakerTag,
            startMs,
            endMs,
            confidence,
          });
        }
      };

      ws.onclose = () => {
        console.log("Deepgram WS closed");
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
    } catch (err) {
      console.error("Start recording error:", err);
      setStatus("failed");
      onStatusChange("failed");
      onError("Không thể kết nối đến máy chủ ghi âm hoặc microphone.");
    }
  }, [meetingId, selectedDeviceId, echoCancellation, noiseSuppression, autoGainControl, chunkSize, connectDeepgram, startVolumeAnalysis, onTranscript, onStatusChange, onError]);

  // 5. Pause recording
  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setStatus("preparing");
      onStatusChange("preparing");
    }
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
