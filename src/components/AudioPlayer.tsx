"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";

interface AudioPlayerProps {
  blobUrl: string;
  transcripts: { id: string; start_ms: number; end_ms: number }[];
  activeTranscriptId: string | null;
  onTimeUpdate: (currentTimeMs: number) => void;
  onSeekToTranscript: (startMs: number) => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function AudioPlayer({
  blobUrl,
  transcripts,
  activeTranscriptId,
  onTimeUpdate,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Format time mm:ss
  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Handle time update
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(audio.currentTime);
        onTimeUpdate(audio.currentTime * 1000); // Convert to ms
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [isDragging, onTimeUpdate]);

  // Play/Pause
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Seek on progress bar click
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    const bar = progressRef.current;
    if (!audio || !bar) return;

    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  // Seek to specific time (called from transcript click)
  const seekTo = useCallback((timeMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = timeMs / 1000;
    setCurrentTime(audio.currentTime);
    if (!isPlaying) {
      audio.play();
      setIsPlaying(true);
    }
  }, [isPlaying]);

  // Expose seekTo and togglePlay globally
  useEffect(() => {
    (window as any).__audioPlayerSeekTo = seekTo;
    (window as any).__audioPlayerTogglePlay = togglePlay;
    return () => {
      delete (window as any).__audioPlayerSeekTo;
      delete (window as any).__audioPlayerTogglePlay;
    };
  }, [seekTo, togglePlay]);

  // Speed change
  const cycleSpeed = () => {
    const audio = audioRef.current;
    if (!audio) return;

    const currentIdx = SPEED_OPTIONS.indexOf(speed);
    const nextIdx = (currentIdx + 1) % SPEED_OPTIONS.length;
    const newSpeed = SPEED_OPTIONS[nextIdx];
    audio.playbackRate = newSpeed;
    setSpeed(newSpeed);
  };

  // Mute/Unmute
  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  // Skip forward/backward 10s
  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
    setCurrentTime(audio.currentTime);
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <>
      <audio ref={audioRef} src={blobUrl} preload="metadata" />

      {/* Sticky bottom player */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-lg border-t border-slate-200 dark:border-slate-800 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        {/* Progress bar — clickable */}
        <div
          ref={progressRef}
          onClick={handleProgressClick}
          className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 cursor-pointer group hover:h-2.5 transition-all"
        >
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-r-full relative transition-all"
            style={{ width: `${progressPercent}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-md" />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between px-4 py-2 max-w-4xl mx-auto">
          {/* Left: time */}
          <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400 w-24">
            <span>{formatTime(currentTime)}</span>
            <span>/</span>
            <span>{formatTime(duration)}</span>
          </div>

          {/* Center: controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => skip(-10)}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
              title="Lùi 10 giây"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              onClick={togglePlay}
              className="p-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-full transition-colors shadow-md cursor-pointer"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5" />
              ) : (
                <Play className="w-5 h-5 ml-0.5" />
              )}
            </button>

            <button
              onClick={() => skip(10)}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
              title="Tới 10 giây"
            >
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          {/* Right: speed + volume */}
          <div className="flex items-center gap-2 w-24 justify-end">
            <button
              onClick={cycleSpeed}
              className="px-2 py-1 text-xs font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md transition-colors cursor-pointer"
            >
              {speed}x
            </button>

            <button
              onClick={toggleMute}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              {isMuted ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
