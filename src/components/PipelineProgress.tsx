"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CheckCircle2, Circle, Loader2, XCircle, Ban, Play, 
  Upload, Mic, FileSearch, Languages, Brain, ListChecks,
  Save, AlertTriangle, RotateCcw
} from "lucide-react";

const PIPELINE_STEPS = [
  { key: "uploading", label: "Tải âm thanh", icon: Upload, chunked: false },
  { key: "transcribing", label: "Bóc băng giọng nói (AI)", icon: Mic, chunked: true },
] as const;

interface PipelineProgressProps {
  meetingId: string;
  initialStatus: string;
  initialProgress?: {
    percent?: number;
    chunk_current?: number;
    chunk_total?: number;
    message?: string;
  } | null;
  onCompleted: () => void;
  onCancel: () => void;
  onResume: () => void;
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
  const [progress, setProgress] = useState(initialProgress || null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  // Subscribe to Supabase Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`meeting-progress-${meetingId}`)
      .on(
        "postgres_changes" as any,
        {
          event: "UPDATE",
          schema: "public",
          table: "meetings",
          filter: `id=eq.${meetingId}`,
        },
        (payload: any) => {
          const newStatus = payload.new.status;
          const newProgress = payload.new.progress;

          setStatus(newStatus);
          if (newProgress) setProgress(newProgress);

          if (newStatus === "ready" || newStatus === "completed") {
            // Delay chút để animation hoàn tất
            setTimeout(() => onCompleted(), 1500);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [meetingId, supabase, onCompleted]);

  // Fallback Polling (in case Realtime connection is unstable or missed)
  useEffect(() => {
    if (["ready", "completed", "failed", "cancelled"].includes(status)) return;

    const interval = setInterval(async () => {
      try {
        const { data, error } = await supabase
          .from("meetings")
          .select("status, progress")
          .eq("id", meetingId)
          .single();

        if (error) throw error;

        if (data) {
          if (data.status !== status) {
            setStatus(data.status);
          }
          if (data.progress) {
            setProgress(data.progress);
          }

          if (data.status === "ready" || data.status === "completed") {
            clearInterval(interval);
            setTimeout(() => onCompleted(), 1500);
          }
        }
      } catch (err) {
        console.error("[PipelineProgress] Polling fallback error:", err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [meetingId, supabase, status, onCompleted]);

  // Xác định trạng thái của từng step
  const getStepState = (stepKey: string) => {
    const stepIndex = PIPELINE_STEPS.findIndex((s) => s.key === stepKey);
    const currentIndex = PIPELINE_STEPS.findIndex((s) => s.key === status);

    if (status === "ready" || status === "completed") return "done";
    if (status === "failed" || status === "cancelled") {
      const percentMap: Record<number, string> = {
        2: "uploading",
        10: "transcribing",
      };
      
      const failedStepKey = percentMap[progress?.percent || 0];
      const failedStepIndex = failedStepKey ? PIPELINE_STEPS.findIndex((s) => s.key === failedStepKey) : 0;
      
      if (stepIndex < failedStepIndex) return "done";
      if (stepIndex === failedStepIndex) return status === "failed" ? "failed" : "cancelled";
      return "pending";
    }
    if (stepIndex < currentIndex) return "done";
    if (stepIndex === currentIndex) return "active";
    return "pending";
  };

  // Tính phần trăm tổng thể
  const getOverallPercent = () => {
    if (status === "ready" || status === "completed") return 100;
    if (status === "queued") return 0;

    const currentIndex = PIPELINE_STEPS.findIndex((s) => s.key === status);
    if (currentIndex === -1) return 0;

    const stepPercent = progress?.percent || 0;
    const totalSteps = PIPELINE_STEPS.length;
    const basePercent = (currentIndex / totalSteps) * 100;
    const stepWeight = (1 / totalSteps) * 100;

    return Math.round(basePercent + (stepPercent / 100) * stepWeight);
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      const res = await fetch("/api/meetings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId }),
      });
      if (!res.ok) throw new Error("Failed to cancel");
      onCancel();
    } catch (err) {
      console.error("Cancel error:", err);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleResume = async () => {
    setIsResuming(true);
    try {
      const res = await fetch("/api/meetings/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId }),
      });
      if (!res.ok) throw new Error("Failed to resume");
      onResume();
    } catch (err) {
      console.error("Resume error:", err);
    } finally {
      setIsResuming(false);
    }
  };

  const overallPercent = getOverallPercent();
  const isProcessing = !["ready", "completed", "failed", "cancelled", "queued"].includes(status);
  const isTerminal = ["ready", "completed", "failed", "cancelled"].includes(status);

  return (
    <div className="w-full max-w-xl mx-auto">
      {/* Overall progress bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
            Tiến trình xử lý
          </span>
        </div>
        <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden relative">
          {status === "failed" ? (
            <div className="h-full rounded-full bg-red-500 w-full" />
          ) : status === "cancelled" ? (
            <div className="h-full rounded-full bg-amber-500 w-full" />
          ) : (status === "ready" || status === "completed") ? (
            <div className="h-full rounded-full bg-emerald-500 w-full" />
          ) : (
            <div className="h-full bg-blue-500 w-full animate-pulse" />
          )}
        </div>
      </div>

      {/* Steps checklist */}
      <div className="space-y-1">
        {PIPELINE_STEPS.map((step) => {
          const state = getStepState(step.key);
          const Icon = step.icon;
          const isActive = state === "active";
          const isDone = state === "done";
          const isFailed = state === "failed";
          const isCancelled = state === "cancelled";

          return (
            <div
              key={step.key}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-300 ${
                isActive
                  ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800"
                  : isFailed
                  ? "bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800"
                  : isCancelled
                  ? "bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800"
                  : isDone
                  ? "bg-slate-50 dark:bg-slate-900/50"
                  : "opacity-50"
              }`}
            >
              {/* Status icon */}
              <div className="shrink-0">
                {isDone && (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                )}
                {isActive && (
                  <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                )}
                {isFailed && (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                {isCancelled && (
                  <Ban className="w-5 h-5 text-amber-500" />
                )}
                {state === "pending" && (
                  <Circle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                )}
              </div>

              {/* Step info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${
                    isDone ? "text-emerald-500" : 
                    isActive ? "text-blue-500" : 
                    isFailed ? "text-red-500" : 
                    "text-slate-400 dark:text-slate-500"
                  }`} />
                  <span className={`text-sm font-semibold ${
                    isDone ? "text-emerald-700 dark:text-emerald-400" : 
                    isActive ? "text-blue-700 dark:text-blue-300" : 
                    isFailed ? "text-red-700 dark:text-red-400" :
                    isCancelled ? "text-amber-700 dark:text-amber-400" :
                    "text-slate-500 dark:text-slate-400"
                  }`}>
                    {step.label}
                  </span>
                </div>
              </div>

              {/* Progress detail */}
              <div className="shrink-0 text-right">
                {isActive && (
                  <div className="flex flex-col items-end">
                    <span className="text-xs font-bold text-blue-600 dark:text-blue-400">
                      Đang xử lý...
                    </span>
                  </div>
                )}
                {isDone && (
                  <span className="text-xs text-emerald-500">✓</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Status message */}
      {progress?.message && status !== "completed" && (
        <div className={`mt-4 text-center text-sm ${status === "failed" ? "text-red-500 font-semibold dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}>
          {progress.message}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex items-center justify-center gap-3">
        {isProcessing && (
          <button
            onClick={handleCancel}
            disabled={isCancelling}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
          >
            {isCancelling ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Ban className="w-4 h-4" />
            )}
            Hủy xử lý
          </button>
        )}

        {(status === "failed" || status === "cancelled") && (
          <button
            onClick={handleResume}
            disabled={isResuming}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
          >
            {isResuming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Tiếp tục xử lý
          </button>
        )}

        {status === "failed" && (
          <div className="flex items-center gap-2 text-sm text-red-500 dark:text-red-400">
            <AlertTriangle className="w-4 h-4" />
            <span>Đã xảy ra lỗi. Bấm "Tiếp tục" để thử lại.</span>
          </div>
        )}

        {status === "cancelled" && (
          <div className="flex items-center gap-2 text-sm text-amber-500 dark:text-amber-400">
            <Ban className="w-4 h-4" />
            <span>Đã hủy. Bấm "Tiếp tục" để xử lý tiếp.</span>
          </div>
        )}
      </div>

      {/* Completed celebration */}
      {(status === "ready" || status === "completed") && (
        <div className="mt-6 text-center">
          <div className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 rounded-xl border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-bold text-sm">Hoàn thành! Đang tải kết quả...</span>
          </div>
        </div>
      )}
    </div>
  );
}
