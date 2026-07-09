"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";

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

  // Fallback duration from transcripts
  const fallbackDuration = useMemo(() => {
    if (!transcripts || transcripts.length === 0) return 0;
    const maxEndMs = Math.max(...transcripts.map((t) => t.end_ms || 0));
    return maxEndMs / 1000;
  }, [transcripts]);

  const effectiveDuration = duration > 0 && isFinite(duration) ? duration : (fallbackDuration > 0 ? fallbackDuration : 0);

  const [speed, setSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  // Format time mm:ss
  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
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
      // Check if duration has become available
      if (audio.duration && isFinite(audio.duration) && !isNaN(audio.duration) && audio.duration !== duration) {
        setDuration(audio.duration);
      }
    };

    const handleLoadedMetadata = () => {
      if (audio.duration === Infinity && audio.currentTime === 0 && audio.paused) {
        audio.currentTime = 1e101;
        audio.addEventListener("seeked", function tempSeeked() {
          audio.removeEventListener("seeked", tempSeeked);
          audio.currentTime = 0;
          if (isFinite(audio.duration) && !isNaN(audio.duration)) {
            setDuration(audio.duration);
          }
        }, { once: true });
      } else if (isFinite(audio.duration) && !isNaN(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("durationchange", handleLoadedMetadata);
    audio.addEventListener("canplay", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("durationchange", handleLoadedMetadata);
      audio.removeEventListener("canplay", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [isDragging, onTimeUpdate, duration]);

  // Play/Pause
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      try {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            setIsPlaying(true);
          }).catch(err => {
            console.warn("Audio playback failed (possibly expired blob url):", err);
            setIsPlaying(false);
          });
        } else {
          setIsPlaying(true);
        }
      } catch (err) {
        console.warn("Audio play synchronous error:", err);
        setIsPlaying(false);
      }
    }
  };

  // Seek on progress bar click
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    const bar = progressRef.current;
    if (!audio || !bar || isNaN(effectiveDuration) || !isFinite(effectiveDuration) || effectiveDuration <= 0) return;

    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * effectiveDuration;
    setCurrentTime(audio.currentTime);
  };

  // Seek to specific time (called from transcript click)
  const seekTo = useCallback((timeMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = timeMs / 1000;
    setCurrentTime(audio.currentTime);
    if (!isPlaying) {
      try {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            setIsPlaying(true);
          }).catch(err => {
            console.warn("Audio playback failed (possibly expired blob url):", err);
            setIsPlaying(false);
          });
        } else {
          setIsPlaying(true);
        }
      } catch (err) {
        console.warn("Audio play synchronous error:", err);
        setIsPlaying(false);
      }
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

    const targetDuration = effectiveDuration > 0 ? effectiveDuration : audio.duration;
    if (isFinite(targetDuration) && !isNaN(targetDuration) && targetDuration > 0) {
      audio.currentTime = Math.max(0, Math.min(targetDuration, audio.currentTime + seconds));
    } else {
      audio.currentTime = Math.max(0, audio.currentTime + seconds);
    }
    setCurrentTime(audio.currentTime);
  };

  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;

  return (
    <>
      <audio ref={audioRef} src={blobUrl} preload="metadata" muted={isMuted} />

      {/* Sticky bottom player */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-[calc(1366px-2rem)] 2xl:max-w-[calc(1600px-2rem)] z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-lg border-x border-t border-slate-200 dark:border-slate-800 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <div className="w-full relative">
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
            {/* Playback pointer/indicator (always visible, scales up on hover) */}
            <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white border-2 border-blue-500 dark:border-indigo-400 rounded-full shadow-md scale-90 group-hover:scale-125 transition-all cursor-pointer z-10" />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between px-4 py-2">
          {/* Left: time */}
          <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400 w-24">
            <span>{formatTime(currentTime)}</span>
            <span>/</span>
            <span>{formatTime(effectiveDuration)}</span>
          </div>

          {/* Center: controls */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => skip(-10)}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
              title="Lùi 10 giây"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <text x="12" y="15.5" fontSize="7" fontWeight="500" textAnchor="middle" fill="currentColor" stroke="none">10</text>
              </svg>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <text x="12" y="15.5" fontSize="7" fontWeight="500" textAnchor="middle" fill="currentColor" stroke="none">10</text>
              </svg>
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
    </div>
  </>
  );
}
