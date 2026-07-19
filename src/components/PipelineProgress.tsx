"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CheckCircle2, Circle, Loader2, XCircle, Ban, Play,
  Upload, Mic, Languages, ListChecks, AlertTriangle, RotateCcw, Clock,
} from "lucide-react";

// ================================================================
// 4 giai đoạn của hành trình xử lý, khớp thang % backend ghi vào
// meetings.progress: upload 0-5 → transcribe 5-35 → process 35-85 → summary 85-100
// ================================================================
const STEPS = [
  { key: "upload", label: "Tải bản ghi", icon: Upload, from: 0, to: 5 },
  { key: "transcribe", label: "Tạo bản ghi văn bản", icon: Mic, from: 5, to: 35 },
  { key: "process", label: "Phân vai & dịch", icon: Languages, from: 35, to: 85 },
  { key: "summary", label: "Tóm tắt & công việc", icon: ListChecks, from: 85, to: 100 },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

interface ProgressData {
  percent?: number;
  chunk_current?: number;
  chunk_total?: number;
  message?: string;
  stage?: string;
  updated_at?: string;
}

interface PipelineProgressProps {
  meetingId: string;
  initialStatus: string;
  initialProgress?: ProgressData | null;
  onCompleted: () => void;
  onCancel: () => void;
  onResume: () => void;
}

const TERMINAL_STATUSES = ["ready", "completed", "failed", "cancelled"];

// Suy ra % toàn hành trình từ status + progress (tương thích cả dữ liệu cũ)
function deriveServerPercent(status: string, progress: ProgressData | null): number {
  if (status === "ready" || status === "completed") return 100;
  const p = typeof progress?.percent === "number" ? progress.percent : 0;
  if (status === "queued") return Math.max(1, p);
  if (status === "uploading") return Math.max(3, Math.min(p, 5));
  if (status === "transcribing") return Math.max(8, Math.min(Math.max(p, 8), 34));
  // processing & các status khác: tin percent backend (35-100)
  return p;
}

// Suy ra giai đoạn hiện tại
function deriveStage(status: string, progress: ProgressData | null, percent: number): StepKey {
  const stage = progress?.stage;
  if (stage === "upload" || stage === "transcribe" || stage === "process" || stage === "summary") {
    return stage;
  }
  if (status === "uploading" || status === "queued") return "upload";
  if (status === "transcribing") return "transcribe";
  // Fallback theo %
  const step = STEPS.find((s) => percent < s.to) || STEPS[STEPS.length - 1];
  return step.key;
}

export default function PipelineProgress({
  meetingId,
  initialStatus,
  initialProgress,
  onCompleted,
  onCancel,
  onResume,
}: PipelineProgressProps) {
  const supabase = createClient();
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState<ProgressData | null>(initialProgress || null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  // Giữ modal thêm một nhịp để chạy hiệu ứng đóng trước khi gỡ khỏi DOM.
  const [cancelModalClosing, setCancelModalClosing] = useState(false);
  const closeCancelConfirm = useCallback(() => {
    setCancelModalClosing(true);
    setTimeout(() => {
      setShowCancelConfirm(false);
      setCancelModalClosing(false);
    }, 150);
  }, []);
  const [isResuming, setIsResuming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const completionHandledRef = useRef(false);
  const onCompletedRef = useRef(onCompleted);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const serverPercent = deriveServerPercent(status, progress);
  const isTerminalFail = status === "failed" || status === "cancelled";
  const isDone = status === "ready" || status === "completed";

  // ---- Display percent với "creep" mượt: không bao giờ lùi, tiến chậm dần về
  // trần của giai đoạn hiện tại trong lúc chờ mốc thật tiếp theo từ server ----
  const [displayPercent, setDisplayPercent] = useState(serverPercent);
  const stage = deriveStage(status, progress, Math.max(serverPercent, displayPercent));
  const stageInfo = STEPS.find((s) => s.key === stage) || STEPS[0];

  useEffect(() => {
    // Server có mốc mới cao hơn → nhảy tới; thấp hơn nhiều (retry lại từ đầu) → theo server
    setDisplayPercent((prev) => {
      if (serverPercent >= prev) return serverPercent;
      if (prev - serverPercent > 10) return serverPercent; // xử lý lại từ giai đoạn trước
      return prev;
    });
  }, [serverPercent]);

  useEffect(() => {
    if (isDone || isTerminalFail) return;
    const timer = setInterval(() => {
      setDisplayPercent((prev) => {
        const cap = stageInfo.to - 1; // không vượt trần giai đoạn khi chưa có mốc thật
        if (prev >= cap) return prev;
        return Math.min(cap, prev + Math.max(0.15, (cap - prev) * 0.02));
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isDone, isTerminalFail, stageInfo.to]);

  // ---- ETA: ước lượng theo tốc độ % thực tế quan sát được ----
  const samplesRef = useRef<{ t: number; p: number }[]>([]);
  useEffect(() => {
    const now = Date.now();
    const samples = samplesRef.current;
    const last = samples[samples.length - 1];
    if (last && serverPercent < last.p - 5) {
      // Retry/chạy lại → reset thống kê
      samplesRef.current = [];
    }
    if (!last || serverPercent !== last.p) {
      samplesRef.current = [...samplesRef.current, { t: now, p: serverPercent }].slice(-30);
    }
  }, [serverPercent]);

  const [etaText, setEtaText] = useState<string | null>(null);
  useEffect(() => {
    if (isDone || isTerminalFail) {
      setEtaText(null);
      return;
    }
    const compute = () => {
      const now = Date.now();
      // Chỉ dùng mẫu trong 4 phút gần nhất để phản ánh tốc độ hiện tại
      const samples = samplesRef.current.filter((s) => now - s.t < 240_000);
      if (samples.length < 2) {
        setEtaText(null);
        return;
      }
      const first = samples[0];
      const lastS = samples[samples.length - 1];
      const dt = lastS.t - first.t;
      const dp = lastS.p - first.p;
      if (dt < 5000 || dp <= 0) {
        setEtaText(null);
        return;
      }
      const msRemaining = ((100 - lastS.p) / dp) * dt;
      const minutes = msRemaining / 60000;
      if (minutes < 1) setEtaText("Còn dưới 1 phút");
      else if (minutes < 60) setEtaText(`Còn khoảng ${Math.ceil(minutes)} phút`);
      else setEtaText(`Còn khoảng ${Math.floor(minutes / 60)}g ${Math.ceil(minutes % 60)}p`);
    };
    compute();
    const t = setInterval(compute, 5000);
    return () => clearInterval(t);
  }, [serverPercent, isDone, isTerminalFail]);

  // ---- Realtime + polling fallback ----
  const applyUpdate = useCallback(
    (newStatus: string, newProgress: ProgressData | null) => {
      setStatus(newStatus);
      if (newProgress) setProgress(newProgress);
    },
    []
  );

  // Chỉ hoàn tất navigation một lần. Realtime và polling có thể cùng nhận bản
  // ghi terminal; nếu lên lịch trong applyUpdate, cả hai nguồn sẽ cùng redirect.
  useEffect(() => {
    if (!isDone || completionHandledRef.current) return;
    completionHandledRef.current = true;
    const timer = setTimeout(() => onCompletedRef.current(), 450);
    return () => clearTimeout(timer);
  }, [isDone]);

  useEffect(() => {
    const channel = supabase
      .channel(`meeting-progress-${meetingId}`)
      .on(
        "postgres_changes" as any,
        { event: "UPDATE", schema: "public", table: "meetings", filter: `id=eq.${meetingId}` },
        (payload: any) => applyUpdate(payload.new.status, payload.new.progress)
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, applyUpdate]);

  useEffect(() => {
    if (TERMINAL_STATUSES.includes(status)) return;
    const interval = setInterval(async () => {
      try {
        const { data, error } = await supabase
          .from("meetings")
          .select("status, progress")
          .eq("id", meetingId)
          .single();
        if (!error && data) applyUpdate(data.status, data.progress);
      } catch (err) {
        console.error("[PipelineProgress] Polling fallback error:", err);
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, status, applyUpdate]);

  // ---- Trạng thái từng bước ----
  const currentStepIndex = STEPS.findIndex((s) => s.key === stage);
  const getStepState = (idx: number) => {
    if (isDone) return "done";
    if (idx < currentStepIndex) return "done";
    if (idx === currentStepIndex) {
      if (status === "failed") return "failed";
      if (status === "cancelled") return "cancelled";
      return "active";
    }
    return "pending";
  };

  // ---- Actions ----
  // DỪNG XỬ LÝ: huỷ pipeline + xoá sạch cuộc họp (backend, file audio) và mọi cache
  // phía trình duyệt. Không giữ lại gì ở màn hình chính. Hành động KHÔNG hoàn tác được
  // nên phải xác nhận trước.
  const handleCancel = async () => {
    setShowCancelConfirm(true);
  };

  const performCancel = async () => {
    setShowCancelConfirm(false);
    // Khoá màn hình vào trạng thái "đang xoá" ngay lập tức. Nếu không, realtime
    // đẩy status="cancelled" về giữa chừng và UI nháy qua màn "Đã hủy — bấm Tiếp
    // tục xử lý" khoảng 1 giây trước khi điều hướng, dù cuộc họp đang bị xoá hẳn.
    setIsAborting(true);
    setIsCancelling(true);
    setActionError(null);
    try {
      const res = await fetch("/api/meetings/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không thể dừng xử lý.");

      // Dọn cache phía client để cuộc họp không còn "sống lại" ở bất kỳ đâu.
      try {
        localStorage.removeItem(`meeting_detail_${meetingId}`);
        localStorage.removeItem(`meeting_transcripts_${meetingId}`);
        localStorage.removeItem(`meeting_live_transcript_${meetingId}`);
        localStorage.removeItem(`meeting_recording_duration_${meetingId}`);
        localStorage.removeItem(`meeting_summary_mode_${meetingId}`);
        localStorage.removeItem(`meeting_diarize_mode_${meetingId}`);
        localStorage.removeItem("cached_meetings");
        if (localStorage.getItem("active_meeting_id") === meetingId) {
          localStorage.removeItem("active_meeting_id");
        }
      } catch { /* bỏ qua nếu storage bị chặn */ }

      // Audio (IndexedDB) + bản dịch bản gốc đã cache.
      try {
        const { deleteAudio } = await import("@/lib/audio-cache");
        await deleteAudio(meetingId);
      } catch { /* không có cache audio */ }
      try {
        indexedDB.open("voice_to_text_translation_cache", 1).onsuccess = (e: any) => {
          const db = e.target.result;
          try {
            db.transaction("raw_translations", "readwrite")
              .objectStore("raw_translations")
              .delete(meetingId);
          } catch { /* store chưa tồn tại */ }
        };
      } catch { /* bỏ qua */ }

      onCancel();
      // KHÔNG tắt cờ khi thành công: giữ nguyên màn "đang xoá" cho tới lúc điều
      // hướng hoàn tất, tránh nháy lại UI của cuộc họp vừa bị xoá.
    } catch (err: any) {
      setActionError(String(err.message || err));
      setIsAborting(false);
      setIsCancelling(false);
    }
  };

  const handleResume = async () => {
    setIsResuming(true);
    setActionError(null);
    try {
      const res = await fetch("/api/meetings/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không thể xử lý lại.");
      samplesRef.current = [];
      onResume();
    } catch (err: any) {
      setActionError(String(err.message || err));
    } finally {
      setIsResuming(false);
    }
  };

  const shownPercent = isDone ? 100 : Math.round(displayPercent);
  const barColor = status === "failed"
    ? "bg-red-500"
    : status === "cancelled"
    ? "bg-amber-500"
    : isDone
    ? "bg-emerald-500"
    : "bg-blue-500";

  // Escape đóng modal xác nhận — window.confirm trước đây có sẵn hành vi này.
  useEffect(() => {
    if (!showCancelConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCancelConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCancelConfirm, closeCancelConfirm]);

  const canCancel = !TERMINAL_STATUSES.includes(status);

  // Đang xoá: thay toàn bộ UI tiến trình bằng một trạng thái duy nhất cho tới khi
  // trang điều hướng đi. Không hiện lại thanh %, checklist hay nút nào của cuộc
  // họp sắp biến mất.
  if (isAborting) {
    return (
      <div className="w-full max-w-xl mx-auto py-10 flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
        <p className="text-sm font-semibold text-slate-600 dark:text-slate-400">
          Đang xoá cuộc họp...
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto">
      {/* Overall progress bar — % THẬT từ backend + creep mượt trong giai đoạn */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
            Tiến trình xử lý
          </span>
          <span className={`text-sm font-black font-mono ${
            status === "failed" ? "text-red-500" : status === "cancelled" ? "text-amber-500" : isDone ? "text-emerald-500" : "text-blue-600 dark:text-blue-400"
          }`}>
            {shownPercent}%
          </span>
        </div>
        <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out ${barColor}`}
            style={{ width: `${shownPercent}%` }}
          />
        </div>
        {/* Reserve one fixed row so completion never shifts the card vertically. */}
        <div className="mt-2 h-5 flex items-center justify-end">
          {!isDone && !isTerminalFail && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>{etaText || "Đang ước tính thời gian còn lại..."}</span>
            </div>
          )}
        </div>
      </div>

      {/* Steps checklist */}
      <div className="space-y-1">
        {STEPS.map((step, idx) => {
          const state = getStepState(idx);
          const Icon = step.icon;
          const isActive = state === "active";
          const isStepDone = state === "done";
          const isFailed = state === "failed";
          const isCancelled = state === "cancelled";

          return (
            <div
              key={step.key}
              className={`h-[52px] flex items-center gap-2.5 sm:gap-3 px-3 sm:px-4 rounded-xl box-border transition-colors duration-300 ${
                isActive
                  ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800"
                  : isFailed
                  ? "bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800"
                  : isCancelled
                  ? "bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800"
                  : isStepDone
                  ? "bg-slate-50 dark:bg-slate-900/50"
                  : "opacity-50"
              }`}
            >
              <div className="shrink-0">
                {isStepDone && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                {isActive && <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />}
                {isFailed && <XCircle className="w-5 h-5 text-red-500" />}
                {isCancelled && <Ban className="w-5 h-5 text-amber-500" />}
                {state === "pending" && <Circle className="w-5 h-5 text-slate-300 dark:text-slate-600" />}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 shrink-0 ${
                    isStepDone ? "text-emerald-500" :
                    isActive ? "text-blue-500" :
                    isFailed ? "text-red-500" :
                    "text-slate-400 dark:text-slate-500"
                  }`} />
                  <span className={`min-w-0 truncate whitespace-nowrap text-xs sm:text-sm font-semibold ${
                    isStepDone ? "text-emerald-700 dark:text-emerald-400" :
                    isActive ? "text-blue-700 dark:text-blue-300" :
                    isFailed ? "text-red-700 dark:text-red-400" :
                    isCancelled ? "text-amber-700 dark:text-amber-400" :
                    "text-slate-500 dark:text-slate-400"
                  }`}>
                    {step.label}
                  </span>
                </div>
              </div>

              <div className="shrink-0 text-right">
                {isActive && (
                  <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                    <span className="text-[11px] sm:text-xs font-semibold text-blue-600 dark:text-blue-400">
                      Đang xử lý
                    </span>
                    {step.key === "process" && progress?.chunk_total ? (
                      <span className="inline-flex h-5 items-center rounded-md bg-blue-100/80 dark:bg-blue-900/50 px-1.5 font-mono text-[10px] font-semibold leading-none text-blue-600 dark:text-blue-300">
                        {progress.chunk_current || 0}/{progress.chunk_total}
                      </span>
                    ) : null}
                  </div>
                )}
                {isStepDone && <span className="text-xs text-emerald-500">✓</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Chỉ hiện thông báo backend khi có lỗi; trạng thái bình thường đã được
          thể hiện đầy đủ trong checklist, tránh lặp thông tin trước nút hủy. */}
      {progress?.message && status === "failed" && (
        <div className="mt-4 text-center text-sm text-red-500 font-semibold dark:text-red-400">
          {progress.message}
        </div>
      )}

      {/* Lỗi thao tác (hủy / xử lý lại) */}
      {actionError && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm text-red-500 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 min-h-[42px] flex items-center justify-center gap-3">
        {canCancel && (
          <button
            onClick={handleCancel}
            disabled={isCancelling}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
          >
            {isCancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            Dừng xử lý
          </button>
        )}

        {status === "failed" && (
          <button
            onClick={handleResume}
            disabled={isResuming}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-all disabled:opacity-50 cursor-pointer shadow-sm"
          >
            {isResuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Xử lý lại
          </button>
        )}

        {status === "cancelled" && (
          <button
            onClick={handleResume}
            disabled={isResuming}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
          >
            {isResuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Tiếp tục xử lý
          </button>
        )}

        {isDone && (
          <div className="h-[42px] inline-flex items-center gap-2 px-5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 rounded-xl border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-bold text-sm">Hoàn thành! Đang mở kết quả...</span>
          </div>
        )}
      </div>

      {/* Trạng thái terminal */}
      {status === "failed" && !actionError && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-red-500 dark:text-red-400">
          <AlertTriangle className="w-4 h-4" />
          <span>Xử lý thất bại. Bấm "Xử lý lại" để chạy tiếp từ chỗ dừng.</span>
        </div>
      )}
      {status === "cancelled" && !actionError && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-amber-500 dark:text-amber-400">
          <Ban className="w-4 h-4" />
          <span>Đã hủy. Bấm "Tiếp tục xử lý" để chạy tiếp từ chỗ dừng.</span>
        </div>
      )}

      {/* Xác nhận dừng xử lý — thay window.confirm để khớp giao diện app và
          nêu rõ hậu quả. Hành động này xoá sạch cuộc họp, không hoàn tác được. */}
      {showCancelConfirm && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 dark:bg-slate-950/70 backdrop-blur-sm p-4 ${
            cancelModalClosing
              ? "animate-[modalFadeOut_0.15s_ease-in_forwards]"
              : "animate-[modalFadeIn_0.15s_ease-out]"
          }`}
          onClick={() => closeCancelConfirm()}
        >
          <div
            className={`w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-6 ${
              cancelModalClosing
                ? "animate-[modalPopOut_0.15s_ease-in_forwards]"
                : "animate-[modalPopIn_0.2s_cubic-bezier(0.34,1.56,0.64,1)]"
            }`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start gap-3.5">
              <span className="flex items-center justify-center w-11 h-11 shrink-0 rounded-full bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400">
                <AlertTriangle className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100 leading-snug">
                  Dừng xử lý và xoá cuộc họp?
                </h3>
                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  Toàn bộ bản ghi âm, bản bóc băng và nội dung đã xử lý của cuộc họp này sẽ bị xoá vĩnh viễn.
                </p>
                <p className="mt-2 text-sm font-semibold text-red-600 dark:text-red-400">
                  Không thể khôi phục lại.
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
              <button
                onClick={() => closeCancelConfirm()}
                autoFocus
                className="px-4 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl text-sm font-semibold text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
              >
                Giữ lại cuộc họp
              </button>
              <button
                onClick={performCancel}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition-colors cursor-pointer shadow-sm"
              >
                <Ban className="w-4 h-4" />
                Xoá vĩnh viễn
              </button>
            </div>
          </div>

          <style>{`
            @keyframes modalFadeIn  { from { opacity: 0 } to { opacity: 1 } }
            @keyframes modalFadeOut { from { opacity: 1 } to { opacity: 0 } }
            @keyframes modalPopIn {
              from { opacity: 0; transform: translateY(8px) scale(0.96) }
              to   { opacity: 1; transform: translateY(0) scale(1) }
            }
            @keyframes modalPopOut {
              from { opacity: 1; transform: translateY(0) scale(1) }
              to   { opacity: 0; transform: translateY(4px) scale(0.97) }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}
