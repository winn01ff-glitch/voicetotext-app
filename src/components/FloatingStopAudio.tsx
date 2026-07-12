"use client";

import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Global floating mute/unmute + stop buttons for TTS.
 * Shows two buttons centered at the bottom of the screen when TTS is active:
 * - Tạm dừng / Đọc tiếp (pause/resume toggle)
 * - Dừng phát (cancel completely + dispatches 'tts-force-stop' event)
 * 
 * Automatically shifts up when the AudioPlayer bar is visible at the bottom.
 */
export default function FloatingStopAudio() {
  const [isActive, setIsActive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [audioPlayerHeight, setAudioPlayerHeight] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualPausedRef = useRef(false);
  const forceStopped = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    intervalRef.current = setInterval(() => {
      const synth = window.speechSynthesis;

      // After force stop, wait until synth fully stops before re-detecting
      if (forceStopped.current) {
        if (!synth.speaking && !synth.pending) {
          forceStopped.current = false;
        }
        return;
      }

      // Active when speaking OR we manually paused it
      const active = synth.speaking || synth.pending || manualPausedRef.current;
      setIsActive(active);

      // If speech ended naturally while paused, clean up
      if (manualPausedRef.current && !synth.speaking && !synth.paused && !synth.pending) {
        manualPausedRef.current = false;
        setIsPaused(false);
        setIsActive(false);
      }

      // Detect AudioPlayer height at bottom of screen
      // AudioPlayer uses fixed bottom-0, look for it
      const playerEl = document.querySelector('[class*="fixed bottom-0"][class*="z-40"]') as HTMLElement;
      if (playerEl) {
        setAudioPlayerHeight(playerEl.offsetHeight);
      } else {
        setAudioPlayerHeight(0);
      }
    }, 150);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (isActive) {
      setIsVisible(true);
    } else {
      const timeout = setTimeout(() => setIsVisible(false), 350);
      return () => clearTimeout(timeout);
    }
  }, [isActive]);

  const handleTogglePause = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    if (manualPausedRef.current) {
      // Resume
      synth.resume();
      manualPausedRef.current = false;
      setIsPaused(false);
    } else if (synth.speaking) {
      // Pause
      synth.pause();
      manualPausedRef.current = true;
      setIsPaused(true);
    }
  }, []);

  const handleStop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    
    // Set flag BEFORE cancel to prevent polling from re-activating
    forceStopped.current = true;
    manualPausedRef.current = false;
    
    // Cancel all speech
    window.speechSynthesis.cancel();
    
    // Update UI immediately
    setIsActive(false);
    setIsPaused(false);
    
    // Dispatch custom event so page can clean up its own state (playlist, activeSpeech, etc.)
    window.dispatchEvent(new CustomEvent("tts-force-stop"));
  }, []);

  if (!isVisible) return null;

  // bottom offset: 24px base + audioPlayerHeight when player is visible
  const bottomOffset = audioPlayerHeight > 0 ? audioPlayerHeight + 16 : 24;

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-2 transition-all duration-300 ${
        isActive
          ? "opacity-100 translate-y-0 scale-100"
          : "opacity-0 translate-y-4 scale-90 pointer-events-none"
      }`}
      style={{ bottom: `${bottomOffset}px` }}
    >
      {/* Pause / Resume button */}
      <button
        onClick={handleTogglePause}
        className="flex items-center gap-2 pl-3.5 pr-4 py-2.5 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
        style={{
          background: isPaused
            ? "linear-gradient(135deg, #3b82f6 0%, #2563eb 50%, #1d4ed8 100%)"
            : "linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #b45309 100%)",
          boxShadow: isPaused
            ? "0 4px 20px rgba(59, 130, 246, 0.45)"
            : "0 4px 20px rgba(245, 158, 11, 0.45)",
        }}
        title={isPaused ? "Đọc tiếp" : "Tạm dừng"}
      >
        <div className="relative flex items-center justify-center w-5 h-5">
          {!isPaused && (
            <span
              className="absolute w-8 h-8 rounded-full animate-ping"
              style={{ background: "rgba(255,255,255,0.18)" }}
            />
          )}
          {isPaused ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="relative z-10 text-white">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="relative z-10 text-white">
              <rect x="5" y="4" width="5" height="16" rx="1" />
              <rect x="14" y="4" width="5" height="16" rx="1" />
            </svg>
          )}
        </div>
        <span className="text-sm font-semibold text-white whitespace-nowrap">
          {isPaused ? "Đọc tiếp" : "Tạm dừng"}
        </span>
      </button>

      {/* Stop button */}
      <button
        onClick={handleStop}
        className="flex items-center gap-2 pl-3.5 pr-4 py-2.5 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
        style={{
          background: "linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)",
          boxShadow: "0 4px 20px rgba(239, 68, 68, 0.45)",
        }}
        title="Dừng phát"
      >
        <div className="relative flex items-center justify-center w-5 h-5">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="relative z-10 text-white">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-white whitespace-nowrap">
          Dừng phát
        </span>
      </button>
    </div>
  );
}
