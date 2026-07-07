"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useDeepgramLive } from "@/hooks/useDeepgramLive";
import { Mic, Square, ArrowLeft, Loader2 } from "lucide-react";

interface RecordPageProps {
  params: Promise<{ id: string }>;
}

interface Block {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

// Khoảng lặng (ms) để chốt & tách dòng — ngắn hơn màn hình trực tiếp cho phù hợp ghi chú.
const ENDPOINTING = 1200;

function formatTime(ms: number) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function RecordPage({ params }: RecordPageProps) {
  const { id: meetingId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  const [meeting, setMeeting] = useState<any>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [interim, setInterim] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [isSaving, setIsSaving] = useState(false);

  const blocksRef = useRef<Block[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  // Tải cấu hình cuộc họp (ngôn ngữ nguồn)
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("meetings").select("*").eq("id", meetingId).single();
      setMeeting(data);
    })();
  }, [meetingId]);

  // Tự cuộn xuống cuối
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, interim]);

  // Nhận transcript: chỉ tách dòng theo khoảng lặng, KHÔNG xử lý speaker
  const handleTranscript = useCallback(
    (dg: { text: string; isFinal: boolean; startMs: number; endMs: number }) => {
      if (!dg.text.trim()) return;
      if (!dg.isFinal) {
        setInterim(dg.text);
        return;
      }
      setInterim("");
      const cur = blocksRef.current;
      const last = cur.length ? cur[cur.length - 1] : null;
      const gap = last ? dg.startMs - last.endMs : Infinity;
      if (last && gap < ENDPOINTING) {
        setBlocks((prev) =>
          prev.map((b, i) =>
            i === prev.length - 1 ? { ...b, text: (b.text + " " + dg.text.trim()).trim(), endMs: dg.endMs } : b
          )
        );
      } else {
        setBlocks((prev) => [
          ...prev,
          { id: Math.random().toString(36).slice(2), text: dg.text.trim(), startMs: dg.startMs, endMs: dg.endMs },
        ]);
      }
    },
    []
  );

  const { status, micLevel, checkMicPermission, startRecording, pauseRecording, stopRecording } = useDeepgramLive({
    meetingId,
    sourceLanguage: meeting?.source_language || "auto",
    chunkSize: 100,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    endpointing: ENDPOINTING,
    diarize: false,
    onTranscript: handleTranscript,
    onError: (e) => console.error("[Record] Deepgram error:", e),
    onStatusChange: () => {},
  });

  // Xin quyền mic khi vào trang
  useEffect(() => {
    checkMicPermission();
  }, []);

  // Đồng hồ đếm thời gian khi đang ghi
  useEffect(() => {
    if (status !== "recording") return;
    const iv = setInterval(() => setElapsed((e) => e + 200), 200);
    return () => clearInterval(iv);
  }, [status]);

  const isRecording = status === "recording";

  const toggleRecord = () => {
    if (isRecording) pauseRecording();
    else startRecording();
  };

  const deleteLastLine = () => setBlocks((prev) => prev.slice(0, -1));

  const deleteLastWord = () =>
    setBlocks((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      const words = last.text.trim().split(/\s+/);
      words.pop();
      if (words.length === 0) return prev.slice(0, -1);
      return prev.map((b, i) => (i === prev.length - 1 ? { ...b, text: words.join(" ") } : b));
    });

  const handleFinish = async () => {
    if (isSaving) return;
    setIsSaving(true);
    stopRecording();
    try {
      const rows = blocksRef.current.map((b) => ({
        meeting_id: meetingId,
        original_text: b.text,
        start_ms: b.startMs,
        end_ms: b.endMs,
        speaker_tag: "speaker_1",
        speaker_name: "",
        confidence: 1.0,
        version_type: "RAW",
        version: 1,
        is_active: true,
      }));
      if (rows.length) await supabase.from("transcripts").insert(rows);
      await supabase.from("meetings").update({ status: "ready", duration_ms: elapsed }).eq("id", meetingId);
      router.push(`/history/${meetingId}`);
    } catch (e) {
      console.error("[Record] Save error:", e);
      setIsSaving(false);
    }
  };

  const hasContent = blocks.length > 0 || interim;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans select-none">
      {/* Header */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-3xl w-full mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.push("/")}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
              title="Quay lại"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-sm font-bold truncate">{meeting?.title || "Ghi âm"}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : "bg-slate-300 dark:bg-slate-700"}`} />
            <span className="text-sm font-mono tabular-nums text-slate-600 dark:text-slate-300">{formatTime(elapsed)}</span>
          </div>
        </div>
      </header>

      {/* Transcript */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto px-4 py-6 space-y-3 text-left leading-relaxed">
          {!hasContent && (
            <div className="flex flex-col items-center justify-center text-center text-slate-400 dark:text-slate-500 py-24 space-y-3">
              <Mic className="w-12 h-12 opacity-40" />
              <p className="text-sm">Nhấn nút micro bên dưới để bắt đầu ghi âm.<br />Chữ sẽ chạy theo khi bạn nói.</p>
            </div>
          )}
          {blocks.map((b) => (
            <p key={b.id} className="text-[15px] text-slate-800 dark:text-slate-200">
              {b.text}
            </p>
          ))}
          {interim && <p className="text-[15px] text-slate-400 dark:text-slate-500 italic">{interim}</p>}
        </div>
      </main>

      {/* Control bar */}
      <footer className="sticky bottom-0 border-t border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md">
        <div className="max-w-3xl w-full mx-auto px-4 py-4 flex items-center justify-between gap-3">
          {/* Delete actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={deleteLastWord}
              disabled={blocks.length === 0}
              className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Xóa từ cuối
            </button>
            <button
              onClick={deleteLastLine}
              disabled={blocks.length === 0}
              className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Xóa dòng cuối
            </button>
          </div>

          {/* Big mic button */}
          <button
            onClick={toggleRecord}
            className={`relative w-16 h-16 rounded-full flex items-center justify-center text-white shadow-lg transition-all active:scale-95 cursor-pointer ${
              isRecording ? "bg-red-500 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-700"
            }`}
            title={isRecording ? "Tạm dừng" : "Ghi âm"}
          >
            {isRecording && (
              <span
                className="absolute inset-0 rounded-full bg-red-500/40 animate-ping"
                style={{ transform: `scale(${1 + micLevel / 200})` }}
              />
            )}
            {isRecording ? <Square className="w-6 h-6 relative" fill="currentColor" /> : <Mic className="w-7 h-7 relative" />}
          </button>

          {/* Finish */}
          <button
            onClick={handleFinish}
            disabled={isSaving}
            className="px-4 py-2.5 text-sm font-bold rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {isSaving ? "Đang lưu..." : "Kết thúc"}
          </button>
        </div>
      </footer>
    </div>
  );
}
