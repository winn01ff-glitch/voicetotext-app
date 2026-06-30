"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, use, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useDeepgramLive } from "@/hooks/useDeepgramLive";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Mic, Square, Pause, Settings, RefreshCw, Volume2, Save, HelpCircle,
  Maximize2, Minimize2, Edit, AlertCircle, VolumeX, CheckCircle, ArrowLeft, Merge, X
} from "lucide-react";

interface MeetingRoomProps {
  params: Promise<{ id: string }>;
}

export default function MeetingRoom({ params }: MeetingRoomProps) {
  // Unwrap params using React.use()
  const { id: meetingId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  // Theme state
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Meeting states
  const [meeting, setMeeting] = useState<any>(null);
  const [speakers, setSpeakers] = useState<any[]>([]);
  const [transcripts, setTranscripts] = useState<any[]>([]); // Contains finalized and processed transcripts
  const [realtimeText, setRealtimeText] = useState<{
    text: string;
    interimText: string;
    speakerTag: string;
    speakerName: string;
  } | null>(null);

  const partialTranscript = useMemo(() => {
    if (!realtimeText) return null;
    return {
      text: (realtimeText.text + " " + realtimeText.interimText).trim(),
      speakerTag: realtimeText.speakerTag,
    };
  }, [realtimeText]);

  const [actionItems, setActionItems] = useState<any[]>([]);
  const [glossary, setGlossary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [selectedTargetLang, setSelectedTargetLang] = useState("vi");
  const [selectedVoice, setSelectedVoice] = useState("aura-asteria-en");
  const [lastSavedTime, setLastSavedTime] = useState<string>("");
  const [summaryProgress, setSummaryProgress] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);

  // Audio settings from localStorage
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [chunkSize, setChunkSize] = useState(250);

  // Dynamic speaker colors mapping
  const speakerColorsRef = useRef<{ [key: string]: string }>({});

  // Speaker mapping & merge states
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [speakerToMergeSrc, setSpeakerToMergeSrc] = useState("");
  const [speakerToMergeDest, setSpeakerToMergeDest] = useState("");

  // Toast notifications for real-time action items
  const [toasts, setToasts] = useState<any[]>([]);

  // Refs for auto-scroll
  const parentRef = useRef<HTMLDivElement>(null);
  const transcriptStartTimes = useRef<number>(0);
  const activeSpeakerTimeouts = useRef<Record<string, NodeJS.Timeout>>({});

  // Load meeting configs on mount
  useEffect(() => {
    // Check Dark Mode
    if (document.documentElement.classList.contains("dark")) {
      setIsDarkMode(true);
    }

    // Load audio options
    setEchoCancellation(localStorage.getItem("meeting_echo_cancellation") !== "false");
    setNoiseSuppression(localStorage.getItem("meeting_noise_suppression") !== "false");
    setAutoGainControl(localStorage.getItem("meeting_auto_gain_control") !== "false");
    setChunkSize(parseInt(localStorage.getItem("meeting_chunk_size") || "100"));

    fetchMeetingDetails();
  }, []);

  const fetchMeetingDetails = async () => {
    try {
      const { data: m, error: mErr } = await supabase
        .from("meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      if (mErr || !m) throw new Error("Meeting not found");
      setMeeting(m);
      setSelectedTargetLang(m.target_language);

      // Fetch speakers
      const { data: sps } = await supabase
        .from("speakers")
        .select("*")
        .eq("meeting_id", meetingId);

      const fetchedSpeakers = sps || [];
      setSpeakers(fetchedSpeakers);

      // Map colors
      fetchedSpeakers.forEach((s) => {
        speakerColorsRef.current[s.speaker_tag] = s.color_hex;
      });

      // Fetch existing transcripts (for recovery)
      const { data: txs } = await supabase
        .from("transcripts")
        .select(`
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence,
          speakers ( display_name, color_hex, speaker_tag )
        `)
        .eq("meeting_id", meetingId)
        .order("start_ms", { ascending: true });

      if (txs) {
        setTranscripts(
          txs.map((t: any) => ({
            id: t.id,
            text: t.original_text,
            correctedText: t.corrected_text,
            translatedText: t.translated_text,
            speakerTag: t.speakers?.speaker_tag || "speaker_0",
            speakerName: t.speakers?.display_name || "Unknown",
            startMs: t.start_ms,
            endMs: t.end_ms,
            confidence: t.confidence,
            status: "Translated",
          }))
        );
      }

      // Fetch action items
      const { data: acts } = await supabase
        .from("action_items")
        .select("*")
        .eq("meeting_id", meetingId);
      setActionItems(acts || []);

      // Fetch glossary
      const { data: glo } = await supabase
        .from("glossary")
        .select("*")
        .eq("meeting_id", meetingId);
      setGlossary(glo || []);

      setLoading(false);
    } catch (err) {
      console.error(err);
      alert("Không thể tải thông tin cuộc họp.");
      router.push("/");
    }
  };

  // Re-scroll to bottom on new transcripts (only when a new card is added to prevent layout thrashing)
  useEffect(() => {
    if (parentRef.current && !isFullScreen) {
      const scrollContainer = parentRef.current;
      requestAnimationFrame(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  }, [transcripts.length, isFullScreen]);

  // Toast helper
  const addToast = (title: string, desc: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, title, desc }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  const isJapaneseText = (text: string): boolean => {
    return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
  };

  const joinWithPunctuation = (existing: string, addition: string, isJp: boolean): string => {
    if (!existing) return addition.trim();
    const trimmedExisting = existing.trim();
    const trimmedAddition = addition.trim();
    
    // Check if existing ends with punctuation
    const endsWithPunct = isJp 
      ? /[。、？！?!]/.test(trimmedExisting[trimmedExisting.length - 1])
      : /[.,?!]/.test(trimmedExisting[trimmedExisting.length - 1]);
      
    if (endsWithPunct) {
      return `${trimmedExisting} ${trimmedAddition}`;
    } else {
      const period = isJp ? "。" : ".";
      return `${trimmedExisting}${period} ${trimmedAddition}`;
    }
  };

// Hook Callback when Deepgram yields transcript


  const handleTranscript = useCallback(
    async (dgData: { text: string; isFinal: boolean; speechFinal: boolean; speakerTag: string; startMs: number; endMs: number; confidence: number }) => {
      if (!dgData.text.trim()) return;

      // Allocate speaker color immediately on frontend if not exists
      if (dgData.speakerTag && !speakerColorsRef.current[dgData.speakerTag]) {
        const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
        const existingCount = Object.keys(speakerColorsRef.current).length;
        const color = colors[existingCount % colors.length];
        speakerColorsRef.current[dgData.speakerTag] = color;
      }

      // Find speaker display name
      const sp = speakers.find((s) => s.speaker_tag === dgData.speakerTag);
      const speakerName = sp ? sp.display_name : dgData.speakerTag.replace("speaker_", "Speaker ");

      // 1. If interim (not final): update the separate realtime card state and return
      if (!dgData.isFinal) {
        setRealtimeText({
          text: "",
          interimText: dgData.text,
          speakerTag: dgData.speakerTag,
          speakerName,
        });
        return;
      }

      // 2. If final: clear realtime state and finalize immediately!
      setRealtimeText(null);

      const newBlock = {
        id: Math.random().toString(36).substr(2, 9),
        text: dgData.text.trim(),
        interimText: "",
        correctedText: "",
        translatedText: "",
        speakerTag: dgData.speakerTag,
        speakerName,
        startMs: dgData.startMs || Date.now(),
        endMs: dgData.endMs || Date.now(),
        confidence: dgData.confidence,
        status: "processing" as any,
      };

      setTranscripts((prev) => [...prev, newBlock]);
      processTranscriptBlock(newBlock);
    },
    [speakers, meetingId]
  );

  const processTranscriptBlock = async (block: any) => {
    try {
      setTranscripts(prev => prev.map(t => t.id === block.id ? { ...t, status: "processing" } : t));
      const res = await fetch("/api/process-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          speaker_tag: block.speakerTag,
          original_text: block.text,
          start_ms: block.startMs,
          end_ms: block.endMs,
          confidence: block.confidence,
        }),
      });

      if (!res.ok) {
        throw new Error("Translation failed");
      }

      const data = await res.json();
      setTranscripts(prev =>
        prev.map(t =>
          t.id === block.id
            ? {
                ...t,
                correctedText: data.corrected || block.text,
                translatedText: data.translated,
                status: "completed",
              }
            : t
        )
      );
    } catch (err) {
      console.error(err);
      setTranscripts((prev) =>
        prev.map((t) => (t.id === block.id ? { ...t, status: "Dịch lỗi - Thử lại" } : t))
      );
    }
  };

  // Manual retry for failed AI block
  const handleRetryAI = (block: any) => {
    setTranscripts((prev) =>
      prev.map((t) => (t.id === block.id ? { ...t, status: "processing" } : t))
    );
    processTranscriptBlock(block);
  };

  const handleMicError = (err: string) => {
    alert(`Lỗi ghi âm: ${err}`);
  };

  const handleStatusChange = (newStatus: any) => {
    // Sync states if needed
  };

  // Initialize deepgram live recording hook
  const {
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
  } = useDeepgramLive({
    meetingId,
    sourceLanguage: meeting?.source_language || "auto",
    glossary,
    chunkSize,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    onTranscript: handleTranscript,
    onError: handleMicError,
    onStatusChange: handleStatusChange,
  });

  // Automatically check permission and enter preparing state on load
  useEffect(() => {
    if (meeting) {
      checkMicPermission();
    }
  }, [meeting]);

  // Clear realtime transcript when paused or stopped
  useEffect(() => {
    if (status !== "recording") {
      setRealtimeText(null);
    }
  }, [status]);

  // Audio Playback using Deepgram Aura TTS Route
  const playTtsText = (text: string) => {
    if (!text) return;
    const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}&voice=${selectedVoice}`);
    audio.play().catch((err) => console.error("Play TTS error:", err));
  };

  // Merge speakers action
  const handleMergeSpeakers = async () => {
    if (!speakerToMergeSrc || !speakerToMergeDest || speakerToMergeSrc === speakerToMergeDest) {
      alert("Vui lòng chọn hai Speaker khác nhau để gộp.");
      return;
    }

    try {
      const srcSpeaker = speakers.find((s) => s.speaker_tag === speakerToMergeSrc);
      const destSpeaker = speakers.find((s) => s.speaker_tag === speakerToMergeDest);
      if (!srcSpeaker || !destSpeaker) return;

      // Update all transcripts of source speaker to destination speaker in DB
      const { error: updateTranscriptsError } = await supabase
        .from("transcripts")
        .update({ speaker_id: destSpeaker.id })
        .eq("meeting_id", meetingId)
        .eq("speaker_id", srcSpeaker.id);

      if (updateTranscriptsError) throw updateTranscriptsError;

      // Delete the source speaker row
      await supabase.from("speakers").delete().eq("id", srcSpeaker.id);

      // Local state update
      setSpeakers(speakers.filter((s) => s.speaker_tag !== speakerToMergeSrc));
      setTranscripts((prev) =>
        prev.map((t) =>
          t.speakerTag === speakerToMergeSrc
            ? { ...t, speakerTag: speakerToMergeDest, speakerName: destSpeaker.display_name }
            : t
        )
      );

      setShowMergeModal(false);
      alert(`Gộp Speaker ${speakerToMergeSrc.replace("speaker_", "")} vào ${destSpeaker.display_name} thành công!`);
    } catch (err) {
      console.error("Merge speakers error:", err);
      alert("Có lỗi xảy ra khi gộp người phát biểu.");
    }
  };

  // Dynamic speaker name updates
  const handleRenameSpeaker = async (speakerTag: string, newName: string) => {
    try {
      const sp = speakers.find((s) => s.speaker_tag === speakerTag);
      if (!sp) return;

      const { error } = await supabase
        .from("speakers")
        .update({ display_name: newName })
        .eq("id", sp.id);

      if (error) throw error;

      setSpeakers(speakers.map((s) => (s.speaker_tag === speakerTag ? { ...s, display_name: newName } : s)));
      setTranscripts((prev) =>
        prev.map((t) => (t.speakerTag === speakerTag ? { ...t, speakerName: newName } : t))
      );
    } catch (err) {
      console.error(err);
    }
  };

  // End meeting & trigger Quality model AI summary progress bar
  const handleEndMeeting = async () => {
    if (!confirm("Bạn muốn kết thúc ghi âm cuộc họp và tạo tóm tắt thông minh?")) return;
    
    stopRecording();
    setIsFinishing(true);

    // Calculate duration
    let duration = 0;
    if (transcripts.length > 0) {
      duration = transcripts[transcripts.length - 1].endMs;
    }

    // Run summary progress animation
    const interval = setInterval(() => {
      setSummaryProgress((prev) => {
        if (prev >= 90) {
          clearInterval(interval);
          return 90;
        }
        return prev + 10;
      });
    }, 1500);

    try {
      const res = await fetch("/api/end-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          duration_ms: duration,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "End meeting error");

      setSummaryProgress(100);
      clearInterval(interval);

      // Clean active meeting key in localStorage
      localStorage.removeItem("active_meeting_id");

      // Redirect to history details
      setTimeout(() => {
        router.push(`/history/${meetingId}`);
      }, 500);
    } catch (err) {
      console.error(err);
      clearInterval(interval);
      alert("Lỗi khi kết thúc cuộc họp và tạo tóm tắt.");
      setIsFinishing(false);
      setStatus("completed");
    }
  };



  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mb-4" />
        <span className="text-slate-500 font-medium">Đang kết nối phòng họp...</span>
      </div>
    );
  }

  // If finishing, render Progress Page
  if (isFinishing) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 px-6">
        <div className="max-w-md w-full space-y-6 text-center">
          <RefreshCw className="w-12 h-12 text-blue-500 animate-spin mx-auto" />
          <div className="space-y-2">
            <h3 className="font-bold text-xl text-slate-900 dark:text-slate-100">
              Đang tạo báo cáo tóm tắt cuộc họp
            </h3>
            <p className="text-sm text-slate-500">
              Gemini 3.5 Pro đang xử lý phân tích cuộc thoại để trích xuất báo cáo tổng quan, quyết định và danh sách công việc...
            </p>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-800 h-3 rounded-full overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300"
              style={{ width: `${summaryProgress}%` }}
            ></div>
          </div>
          <span className="text-xs text-slate-400 font-medium">
            Tiến trình: {summaryProgress}% (Ước tính còn lại: {Math.max(0, 15 - Math.round((summaryProgress / 100) * 15))} giây)
          </span>
        </div>
      </div>
    );
  }

  // If in FULL SCREEN Mode, render minimal clean caption view
  if (isFullScreen) {
    const lastTxs = transcripts.filter(t => t.status !== "realtime").slice(-3); // Get last 3 stable lines
    return (
      <div className="min-h-screen flex flex-col bg-slate-900 text-white p-12 justify-center relative">
        {/* Exit Full Screen Button */}
        <button
          onClick={() => setIsFullScreen(false)}
          className="absolute top-8 right-8 flex items-center space-x-2 px-4 h-10 bg-white/10 hover:bg-white/20 text-white rounded-md text-sm transition-all"
        >
          <Minimize2 className="w-4 h-4" />
          <span>Thoát Toàn Màn Hình</span>
        </button>

        {/* Pulsing Recording State Indicator */}
        <div className="absolute top-8 left-8 flex items-center space-x-2">
          <span className="w-3.5 h-3.5 bg-red-500 rounded-full animate-ping"></span>
          <span className="text-xs text-slate-400 tracking-wider font-semibold">LIVE CAPTION MODE</span>
        </div>

        {/* Captions Stack */}
        <div className="max-w-5xl mx-auto w-full space-y-12">
          {lastTxs.map((t) => (
            <div key={t.id} className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <span className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: speakerColorsRef.current[t.speakerTag] || "#60a5fa" }}>
                <span>●</span>
                <span>{t.speakerName}</span>
              </span>
              <p className="text-3xl md:text-5xl font-bold leading-tight">
                {t.correctedText || t.text}
              </p>
              {t.translatedText && (
                <p className="text-2xl md:text-4xl italic text-slate-400 font-medium leading-tight">
                  {t.translatedText}
                </p>
              )}
            </div>
          ))}
          {partialTranscript && (
            <div className="space-y-3 opacity-60">
              <span className="text-xs font-bold uppercase flex items-center gap-1.5" style={{ color: speakerColorsRef.current[partialTranscript.speakerTag] || "#64748b" }}>
                <span>●</span>
                <span>{speakers.find((s) => s.speaker_tag === partialTranscript.speakerTag)?.display_name || "Phát biểu..."}</span>
              </span>
              <p className="text-2xl md:text-4xl italic text-slate-300">
                "{partialTranscript.text}..."
              </p>
            </div>
          )}
          {transcripts.length === 0 && !partialTranscript && (
            <div className="text-center text-slate-500 text-2xl italic">
              Đang chờ luồng âm thanh họp phát biểu...
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans overflow-hidden">
      {/* HEADER */}
      <header className="w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 px-4 h-16 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <button
            onClick={() => router.push("/")}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center space-x-2">
            <h1 className="font-bold text-lg leading-none">{meeting.title}</h1>
          </div>
        </div>

        {/* Auto Save Status */}
        <div className="flex items-center space-x-4 text-xs">
          {lastSavedTime ? (
            <span className="text-slate-400 font-medium flex items-center space-x-1">
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
              <span>Đã lưu tự động lúc {lastSavedTime} ✓</span>
            </span>
          ) : (
            <span className="text-slate-400 font-medium italic">Đang đồng bộ cơ sở dữ liệu...</span>
          )}
          <button
            onClick={() => setIsFullScreen(true)}
            className="flex items-center space-x-1 px-3 h-8 border border-slate-200 dark:border-slate-800 rounded-md text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Phụ đề Live (iPad)</span>
          </button>
        </div>
      </header>

      {/* CORE MEETING SECTION: PC 2-Column Split */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Left Column: Side Controls & Speaker Config */}
        <aside className="w-full md:w-[360px] bg-white/60 dark:bg-slate-900/40 backdrop-blur-md border-b md:border-b-0 md:border-r border-slate-200/60 dark:border-slate-800 p-7 flex flex-col gap-8 shrink-0 overflow-y-auto z-10 shadow-[2px_0_15px_-3px_rgba(0,0,0,0.05)] dark:shadow-none custom-scrollbar">
          {/* Ghi âm control */}
          <div className="space-y-4">
            <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400">Trạng thái ghi âm</h4>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center space-x-2.5">
                    <span
                      className={`w-3 h-3 rounded-full ${
                        status === "recording" ? "bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]" : "bg-slate-300"
                      }`}
                    ></span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300 capitalize">{status === "recording" ? "Đang ghi âm" : "Tạm dừng"}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Volume2 className="w-4 h-4 text-slate-400" />
                    <span className="text-xs font-bold text-slate-500 w-8 text-right">{micLevel}%</span>
                  </div>
                </div>
                
                <div className="px-4 pb-4">
                  <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
                    <div 
                      className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-400 transition-all duration-75" 
                      style={{ width: `${micLevel}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              {/* Controls */}
              <div className="grid grid-cols-2 gap-3 mt-1">
                {status === "recording" ? (
                  <button
                    onClick={pauseRecording}
                    className="flex items-center justify-center space-x-2 bg-blue-50 hover:bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shadow-sm"
                  >
                    <Pause className="w-4 h-4" />
                    <span>Tạm dừng</span>
                  </button>
                ) : (
                  <button
                    onClick={startRecording}
                    className="flex items-center justify-center space-x-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] shadow-md shadow-indigo-500/30 cursor-pointer"
                  >
                    <Mic className="w-4 h-4" />
                    <span>{transcripts.length > 0 ? "Tiếp tục" : "Ghi âm"}</span>
                  </button>
                )}

                <button
                  onClick={handleEndMeeting}
                  className="flex items-center justify-center space-x-2 bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shadow-sm"
                >
                  <Square className="w-4 h-4" />
                  <span>Kết thúc</span>
                </button>
              </div>
            </div>
          </div>

          {/* Speakers mappings */}
          <div className="space-y-4 flex-1">
            <div className="flex justify-between items-center">
              <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400">Người phát biểu</h4>
              <button
                onClick={() => setShowMergeModal(true)}
                className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 px-2 py-1 rounded-md flex items-center space-x-1 transition-colors"
              >
                <Merge className="w-3.5 h-3.5" />
                <span>Gộp người</span>
              </button>
            </div>

            <div className="space-y-3">
              {speakers.map((s) => (
                <div key={s.id} className={`bg-white dark:bg-slate-900 border ${partialTranscript?.speakerTag === s.speaker_tag ? "border-blue-300 dark:border-blue-700 shadow-md ring-2 ring-blue-100 dark:ring-blue-900/30" : "border-slate-100 dark:border-slate-800 shadow-sm"} rounded-xl p-3 transition-all hover:shadow-md`}>
                  <div className="flex items-center space-x-3">
                    <span
                      className="w-3 h-3 rounded-full shrink-0 shadow-sm"
                      style={{ backgroundColor: s.color_hex }}
                    ></span>
                    <input
                      type="text"
                      value={s.display_name}
                      onChange={(e) => handleRenameSpeaker(s.speaker_tag, e.target.value)}
                      className="flex-1 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-500 font-bold text-sm focus:outline-none py-1 text-slate-700 dark:text-slate-200 transition-colors"
                    />
                    <span className="text-[10px] uppercase font-bold text-slate-400 select-none bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded-md">
                      {s.speaker_tag.replace("speaker_", "")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Target language & Voice playback settings */}
          <div className="space-y-4 pt-6 border-t border-slate-200/60 dark:border-slate-800">
            <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400">Cấu hình Dịch &amp; Đọc</h4>
            <div className="space-y-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400">Dịch sang ngôn ngữ</label>
                <select
                  value={selectedTargetLang}
                  onChange={(e) => setSelectedTargetLang(e.target.value)}
                  className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500/50 focus:outline-none transition-all"
                >
                  <option value="vi">Tiếng Việt (vi)</option>
                  <option value="ja">Tiếng Nhật (ja)</option>
                  <option value="en">Tiếng Anh (en)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400">Giọng đọc (Phát âm)</label>
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500/50 focus:outline-none transition-all"
                >
                  <option value="aura-asteria-en">Aura Asteria (Nữ Mỹ)</option>
                  <option value="aura-athena-en">Aura Athena (Nữ Anh)</option>
                  <option value="aura-orion-en">Aura Orion (Nam Anh)</option>
                </select>
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column: Real-time Transcript Virtualized Feed */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-950 p-6 relative">
          <div
            ref={parentRef}
            className="flex-1 overflow-y-auto custom-scrollbar pr-4 space-y-4"
          >
            <div className="flex flex-col gap-3">
              {transcripts.map((t) => {
                const needsReview = t.confidence < 0.7;
                const isProcessing = t.status === "processing";
                const isError = t.status === "Dịch lỗi - Thử lại";

                return (
                  <div key={t.id}>
                    <div className="flex flex-col p-3.5 rounded-xl shadow-sm hover:shadow-md transition-all duration-300 bg-white border border-slate-100 dark:bg-slate-900 dark:border-slate-800/60 relative group">
                      {/* Bubble Header */}
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center space-x-2">
                          <span className="text-[10px] text-slate-400 font-semibold bg-slate-50 dark:bg-slate-800/50 px-2 py-0.5 rounded-full">
                            {new Date(t.startMs).toISOString().substr(14, 5)}
                          </span>
                        </div>

                        {/* Status (Right side of the Header) */}
                        <div className="flex items-center space-x-2">
                          {needsReview && (
                            <span className="flex items-center space-x-1 text-[10px] font-bold text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/30 shadow-sm" title="Độ tin cậy nhận diện thấp">
                              <AlertCircle className="w-3 h-3" />
                              <span>Cần soát lại</span>
                            </span>
                          )}
                          {isError ? (
                            <button
                              onClick={() => handleRetryAI(t)}
                              className="text-[10px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-950/40 px-2.5 py-0.5 rounded-full flex items-center space-x-1 border border-red-150 dark:border-red-900/50 shadow-sm transition-all cursor-pointer"
                            >
                              <RefreshCw className="w-2.5 h-2.5" />
                              <span>Thử lại</span>
                            </button>
                          ) : isProcessing ? (
                            <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold px-2.5 py-0.5 bg-blue-50/60 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40 rounded-full shadow-sm inline-flex items-center">
                              <span>Đang dịch</span>
                              <span className="inline-flex ml-0.5 w-4 text-left">
                                <span className="animate-pulse">.</span>
                                <span className="animate-pulse [animation-delay:200ms]">.</span>
                                <span className="animate-pulse [animation-delay:400ms]">.</span>
                              </span>
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {/* Bubble Body: Original and Translated Text */}
                      <div className="relative">
                        {/* Original Text Block */}
                        <div className="text-slate-800 dark:text-slate-100 text-sm font-semibold leading-relaxed">
                          {needsReview ? (
                            <span className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-1.5 py-[1px] rounded border border-red-100/50 dark:border-red-900/30 inline">
                              {t.correctedText || t.text}
                            </span>
                          ) : (
                            t.correctedText || t.text
                          )}
                        </div>

                        {/* Separator & Translated Text Block */}
                        {t.translatedText && (
                          <div className="mt-2.5 pt-2.5 border-t border-dashed border-slate-200 dark:border-slate-700/80">
                            <div className="text-emerald-700 dark:text-emerald-400 text-[13px] leading-relaxed font-medium group/trans relative inline-flex items-center mr-2">
                              <span>{t.translatedText}</span>
                              <button
                                onClick={() => playTtsText(t.translatedText)}
                                className="ml-1.5 p-0.5 opacity-0 group-hover:opacity-100 text-slate-400 hover:text-blue-600 bg-slate-50 border border-slate-200 hover:bg-blue-50 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700 rounded transition-all shadow-sm cursor-pointer"
                                title="Nghe"
                              >
                                <Volume2 className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Separate Realtime Caption Section */}
            {realtimeText && (realtimeText.text || realtimeText.interimText) && (
              <div className="flex flex-col bg-blue-50/10 dark:bg-blue-950/5 border-2 border-dashed border-blue-400/40 dark:border-blue-500/30 p-3.5 rounded-xl shadow-sm hover:shadow-md transition-all duration-300 relative animate-[pulse_2.5s_infinite]">
                {/* Bubble Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-600 dark:bg-blue-400 animate-ping"></span>
                      <span>Đang lắng nghe...</span>
                    </span>
                  </div>
                </div>
                {/* Bubble Body */}
                <div className="text-slate-800 dark:text-slate-100 text-sm font-semibold leading-relaxed">
                  {realtimeText.text}
                  {realtimeText.interimText && (
                    <span className="text-slate-400 dark:text-slate-500 font-normal italic ml-1">
                      {realtimeText.interimText}...
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Empty Room Instruction */}
            {transcripts.length === 0 && !partialTranscript && (
              <div className="h-full flex flex-col items-center justify-center text-center p-8">
                <Mic className="w-12 h-12 text-slate-300 dark:text-slate-700 animate-pulse mb-4" />
                <h4 className="font-semibold text-slate-600 dark:text-slate-400">Phòng họp đã sẵn sàng</h4>
                <p className="text-xs text-slate-400 max-w-[280px] mt-1">
                  Nhấn nút "Ghi âm" hoặc bắt đầu nói để trợ lý tự động chuyển đổi ngôn ngữ thời gian thực.
                </p>
              </div>
            )}
          </div>


        </main>
      </div>

      {/* TOASTS NOTIFICATIONS PANEL */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto border border-blue-100 bg-blue-50/95 dark:border-blue-900/50 dark:bg-blue-950/90 p-4 rounded-lg shadow-lg flex items-start space-x-3 animate-in slide-in-from-bottom-5 fade-in duration-300"
          >
            <div className="flex-1">
              <h5 className="font-bold text-xs text-blue-900 dark:text-blue-300">{t.title}</h5>
              <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">{t.desc}</p>
            </div>
            <button
              onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== t.id))}
              className="text-blue-400 hover:text-blue-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* MERGE SPEAKERS MODAL */}
      {showMergeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="font-bold text-lg mb-4 flex items-center space-x-2">
              <Merge className="w-5 h-5 text-blue-500" />
              <span>Gộp Người Phát Biểu</span>
            </h3>
            
            <p className="text-xs text-slate-500 mb-4">
              Nhập mã người nói cần gộp (Ví dụ: Speaker 3) vào người nói đích. Toàn bộ các dòng hội thoại cũ sẽ được gom về một tên duy nhất.
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Người nói nguồn (Cần gộp đi)</label>
                <select
                  value={speakerToMergeSrc}
                  onChange={(e) => setSpeakerToMergeSrc(e.target.value)}
                  className="w-full h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Chọn Speaker nguồn --</option>
                  {speakers.map((s) => (
                    <option key={s.id} value={s.speaker_tag}>
                      {s.display_name} ({s.speaker_tag.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Người nói đích (Gom vào)</label>
                <select
                  value={speakerToMergeDest}
                  onChange={(e) => setSpeakerToMergeDest(e.target.value)}
                  className="w-full h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Chọn Speaker đích --</option>
                  {speakers
                    .filter((s) => s.speaker_tag !== speakerToMergeSrc)
                    .map((s) => (
                      <option key={s.id} value={s.speaker_tag}>
                        {s.display_name} ({s.speaker_tag.toUpperCase()})
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowMergeModal(false)}
                className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md"
              >
                Hủy bỏ
              </button>
              <button
                onClick={handleMergeSpeakers}
                className="px-4 h-9 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md shadow-sm"
              >
                Thực hiện Gộp
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
