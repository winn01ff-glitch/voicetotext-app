"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useDeepgramLive } from "@/hooks/useDeepgramLive";
import {
  Mic, Pause, Play, Trash2, ArrowLeft, RotateCcw, Volume2, Info, Moon, Sun, ArrowRight, ShieldAlert, Sparkles, Check
} from "lucide-react";

interface RecordPageProps {
  params: Promise<{ id: string }>;
}

export default function RecordPage({ params }: RecordPageProps) {
  const { id: meetingId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  // Theme state
  const [isDarkMode, setIsDarkMode] = useState(false);

  // States
  const [meeting, setMeeting] = useState<any>(null);
  const [transcripts, setTranscripts] = useState<any[]>([]);
  const transcriptsRef = useRef<any[]>([]);
  transcriptsRef.current = transcripts;

  const [interimText, setInterimText] = useState("");
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auto-scroll ref
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load theme
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (savedTheme === "dark" || (!savedTheme && systemPrefersDark)) {
      setIsDarkMode(true);
      document.documentElement.classList.add("dark");
    } else {
      setIsDarkMode(false);
      document.documentElement.classList.remove("dark");
    }
  }, []);

  // Fetch meeting details
  useEffect(() => {
    const fetchMeeting = async () => {
      const { data, error } = await supabase
        .from("meetings")
        .select("*")
        .eq("id", meetingId)
        .single();
      
      if (error || !data) {
        setErrorMessage("Không tìm thấy thông tin cuộc ghi âm này.");
        return;
      }
      setMeeting(data);
    };

    fetchMeeting();
  }, [meetingId, supabase]);

  // Handle new transcripts from Deepgram
  const handleTranscript = useCallback(
    async (dgData: { text: string; isFinal: boolean; speechFinal: boolean; speakerTag: string; startMs: number; endMs: number; confidence: number }) => {
      if (!dgData.text.trim()) return;

      // 1. If interim, just update interim text
      if (!dgData.isFinal) {
        setInterimText(dgData.text);
        return;
      }

      setInterimText("");

      // 2. Add to transcripts list and write to DB
      const currentList = transcriptsRef.current;
      const lastBlock = currentList.length > 0 ? currentList[currentList.length - 1] : null;
      const timeGap = lastBlock ? (dgData.startMs - lastBlock.endMs) : 0;
      const isRecent = timeGap < 1200; // 1200ms endpointing gap

      if (lastBlock && isRecent) {
        const updatedText = (lastBlock.text + " " + dgData.text.trim()).trim();
        const updatedBlock = {
          ...lastBlock,
          text: updatedText,
          endMs: dgData.endMs,
        };

        // Update local state
        setTranscripts((prev) => prev.map((t) => (t.id === lastBlock.id ? updatedBlock : t)));

        // Update DB row
        try {
          await supabase
            .from("transcripts")
            .update({
              original_text: updatedText,
              corrected_text: updatedText,
              end_ms: dgData.endMs,
            })
            .eq("id", lastBlock.id);
        } catch (err) {
          console.error("Error updating transcript in DB:", err);
        }
      } else {
        const newBlockId = Math.random().toString(36).substr(2, 9);
        const newBlock = {
          id: newBlockId,
          text: dgData.text.trim(),
          startMs: dgData.startMs,
          endMs: dgData.endMs,
          confidence: dgData.confidence,
          createdAt: new Date().toISOString(),
        };

        // Add to local state
        setTranscripts((prev) => [...prev, newBlock]);

        // Insert into DB
        try {
          await supabase
            .from("transcripts")
            .insert({
              id: newBlockId,
              meeting_id: meetingId,
              original_text: dgData.text.trim(),
              corrected_text: dgData.text.trim(),
              start_ms: dgData.startMs,
              end_ms: dgData.endMs,
              confidence: dgData.confidence,
              version_type: "RAW",
              is_active: true,
            });
        } catch (err) {
          console.error("Error inserting transcript in DB:", err);
        }
      }
    },
    [meetingId, supabase]
  );

  const handleMicError = useCallback((err: string) => {
    console.error("Microphone error:", err);
    setErrorMessage(err);
  }, []);

  const handleStatusChange = useCallback((newStatus: string) => {
    console.log("Deepgram status changed:", newStatus);
  }, []);

  // Hook settings
  const {
    status,
    micLevel,
    startRecording,
    pauseRecording,
    stopRecording,
  } = useDeepgramLive({
    meetingId,
    sourceLanguage: meeting?.source_language || "auto",
    chunkSize: 100,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    endpointing: 1200,
    diarize: false,
    onTranscript: handleTranscript,
    onError: handleMicError,
    onStatusChange: handleStatusChange,
  });

  // Start recording on page load once meeting is loaded
  useEffect(() => {
    if (meeting && status === "idle") {
      startRecording();
    }
  }, [meeting, status, startRecording]);

  // Duration timer
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (status === "recording") {
      interval = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  // Auto scroll to bottom
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [transcripts, interimText]);

  // Helper actions
  const deleteLastLine = async () => {
    const currentList = transcripts;
    if (currentList.length === 0) return;
    const lastBlock = currentList[currentList.length - 1];

    setTranscripts((prev) => prev.slice(0, -1));

    try {
      await supabase
        .from("transcripts")
        .delete()
        .eq("id", lastBlock.id);
    } catch (err) {
      console.error("Error deleting last line:", err);
    }
  };

  const deleteLastWord = async () => {
    const currentList = transcripts;
    if (currentList.length === 0) return;
    const lastBlock = currentList[currentList.length - 1];

    const words = lastBlock.text.trim().split(/\s+/);
    if (words.length <= 1) {
      await deleteLastLine();
    } else {
      const updatedText = words.slice(0, -1).join(" ");
      const updatedBlock = {
        ...lastBlock,
        text: updatedText,
      };

      setTranscripts((prev) => prev.map((t) => (t.id === lastBlock.id ? updatedBlock : t)));

      try {
        await supabase
          .from("transcripts")
          .update({
            original_text: updatedText,
            corrected_text: updatedText,
          })
          .eq("id", lastBlock.id);
      } catch (err) {
        console.error("Error deleting last word:", err);
      }
    }
  };

  const handleEndRecording = async () => {
    try {
      await stopRecording();
      
      // Update meeting status
      await supabase
        .from("meetings")
        .update({
          status: "completed",
        })
        .eq("id", meetingId);

      // replace (not push): removes the now-dead /record/[id] URL from browser
      // history so back/swipe-back doesn't land on a completed recording session.
      router.replace(`/history/${meetingId}`);
    } catch (err) {
      console.error("Error ending recording:", err);
    }
  };

  const toggleTheme = () => {
    const nextDark = !isDarkMode;
    setIsDarkMode(nextDark);
    if (nextDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col font-sans transition-colors duration-300">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate max-w-[200px] sm:max-w-xs">
              {meeting?.title || "Đang tải phòng ghi âm..."}
            </h1>
            <span className="text-[11px] text-slate-400 font-medium">Chế độ Ghi âm (Đơn giản)</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Timer Display */}
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-150 dark:border-red-900/50 rounded-xl px-3 py-1.5 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full bg-red-500 ${status === "recording" ? "animate-pulse" : ""}`}></span>
            <span className="font-mono text-xs font-bold text-red-600 dark:text-red-400">
              {formatDuration(recordingDuration)}
            </span>
          </div>

          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-h-0 max-w-3xl w-full mx-auto p-4 gap-4">
        {/* Error Bar */}
        {errorMessage && (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-150 dark:border-red-900/40 rounded-xl p-3.5 flex items-start gap-2.5 shadow-sm">
            <ShieldAlert className="w-4.5 h-4.5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="text-xs font-bold text-red-900 dark:text-red-300 block mb-0.5">Lỗi Microphone / WebSocket</span>
              <p className="text-[11px] text-red-600 dark:text-red-400 leading-normal">{errorMessage}</p>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-xs text-red-500 hover:underline font-semibold"
            >
              Đóng
            </button>
          </div>
        )}

        {/* Live Audio Visualizer Wave */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${status === "recording" ? "bg-red-50 dark:bg-red-950/30 text-red-500" : "bg-slate-100 dark:bg-slate-800 text-slate-400"}`}>
              <Mic className="w-4 h-4" />
            </div>
            <div>
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">Tín hiệu Mic</span>
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{status}</span>
            </div>
          </div>

          {/* Custom LED Mic indicator */}
          <div className="flex gap-0.5 items-center">
            {Array.from({ length: 15 }).map((_, i) => {
              const active = micLevel * 100 > i * 6;
              return (
                <div
                  key={i}
                  className={`w-1 h-4 rounded-full transition-all duration-75 ${
                    active
                      ? i < 9
                        ? "bg-emerald-500"
                        : i < 13
                        ? "bg-amber-500"
                        : "bg-red-500"
                      : "bg-slate-200 dark:bg-slate-800"
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Real-time transcript area */}
        <div className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 flex flex-col min-h-0 shadow-sm relative overflow-hidden">
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto pr-1 space-y-4 scroll-smooth"
            style={{ contentVisibility: "auto" }}
          >
            {transcripts.map((t) => (
              <div
                key={t.id}
                className="bg-slate-50/50 dark:bg-slate-950/20 border border-slate-100/50 dark:border-slate-800/30 rounded-2xl p-3.5 space-y-1 hover:border-slate-200 dark:hover:border-slate-750 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-bold font-mono">
                    {formatDuration(Math.round(t.startMs / 1000))}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-slate-800 dark:text-slate-100 font-medium">
                  {t.text}
                </p>
              </div>
            ))}

            {/* Interim Transcript */}
            {interimText && (
              <div className="bg-blue-50/20 dark:bg-slate-950/10 border border-dashed border-blue-200/50 dark:border-slate-800/40 rounded-2xl p-3.5 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                  <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wide">AI đang dịch...</span>
                </div>
                <p className="text-[13px] leading-relaxed text-slate-500 dark:text-slate-400 italic">
                  {interimText}
                </p>
              </div>
            )}

            {transcripts.length === 0 && !interimText && (
              <div className="h-full flex flex-col items-center justify-center text-center p-6">
                <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-3">
                  <Sparkles className="w-6 h-6 animate-pulse" />
                </div>
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">Sẵn sàng nhận giọng nói</h3>
                <p className="text-[11px] text-slate-400 max-w-[240px] mt-1">
                  Hãy bắt đầu nói, bản dịch thời gian thực sẽ xuất hiện tại đây.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer Controls */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-4 flex flex-col gap-3.5 shadow-sm">
          {/* Helpers row */}
          <div className="flex justify-between items-center px-1">
            <div className="flex gap-2">
              <button
                onClick={deleteLastWord}
                disabled={transcripts.length === 0}
                className="flex items-center gap-1 text-[11px] font-bold text-slate-600 dark:text-slate-350 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-750 px-3 py-1.5 rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Xóa từ vừa nói cuối cùng"
              >
                Xóa từ cuối
              </button>
              <button
                onClick={deleteLastLine}
                disabled={transcripts.length === 0}
                className="flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 border border-red-100 dark:border-red-900/40 px-3 py-1.5 rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Xóa cả dòng thoại cuối cùng"
              >
                <Trash2 className="w-3 h-3" /> Xóa dòng cuối
              </button>
            </div>

            <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
              {transcripts.length} dòng thoại
            </span>
          </div>

          <div className="h-px bg-slate-100 dark:bg-slate-800" />

          {/* Action buttons */}
          <div className="flex items-center justify-between">
            {/* Record / Pause */}
            <div className="flex items-center gap-3">
              {status === "recording" ? (
                <button
                  onClick={pauseRecording}
                  className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-2xl font-bold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
                >
                  <Pause className="w-4 h-4" /> TẠM DỪNG
                </button>
              ) : (
                <button
                  onClick={startRecording}
                  className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-white" /> TIẾP TỤC
                </button>
              )}
            </div>

            {/* Complete Meeting Button */}
            <button
              onClick={handleEndRecording}
              className="flex items-center gap-1.5 px-5 py-2.5 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-slate-200 text-white dark:text-slate-950 rounded-2xl font-bold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
            >
              KẾT THÚC <Check className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
