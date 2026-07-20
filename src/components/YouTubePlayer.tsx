"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Volume2, VolumeX, ArrowUp, ArrowDown, Minimize2, X, MonitorPlay, ExternalLink } from "lucide-react";

interface YouTubePlayerProps {
  videoId: string;
  sourceUrl: string;
  transcripts: { id: string; start_ms: number; end_ms: number }[];
  activeTranscriptId: string | null;
  onTimeUpdate: (currentTimeMs: number) => void;
  onSeekToTranscript: (startMs: number) => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MUTED_SESSION_KEY = "audio_player_muted";

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

const CORNER_SIZES = [
  { label: "S", w: 320, h: 180 },
  { label: "M", w: 480, h: 270 },
  { label: "L", w: 640, h: 360 },
] as const;

const TOP_BOTTOM_SIZES = [
  { maxW: 640, maxH: 0.30 },
  { maxW: 960, maxH: 0.38 },
  { maxW: 1280, maxH: 0.46 },
] as const;

function getClampedCornerSize(base: { w: number; h: number }) {
  if (typeof window === "undefined") return base;
  const maxW = document.documentElement.clientWidth - 32;
  const maxH = window.innerHeight - 120;
  let w = Math.min(base.w, maxW);
  let h = Math.round(w * 9 / 16);
  if (h > maxH) { h = maxH; w = Math.round(h * 16 / 9); }
  return { w: Math.max(160, w), h: Math.max(90, h) };
}

type VideoPosition = "top" | "bottom" | "corner";

export default function YouTubePlayer({
  videoId,
  sourceUrl,
  transcripts,
  onTimeUpdate,
}: YouTubePlayerProps) {
  const playerRef = useRef<any>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const timeUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [position, setPosition] = useState<VideoPosition>("corner");
  const [cornerSizeIdx, setCornerSizeIdx] = useState(0);

  const [mounted, setMounted] = useState(false);
  const [windowSize, setWindowSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setMounted(true);
    const onResize = () => setWindowSize({ w: document.documentElement.clientWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cornerSize = useMemo(() => {
    if (!mounted) return CORNER_SIZES[cornerSizeIdx];
    return getClampedCornerSize(CORNER_SIZES[cornerSizeIdx]);
  }, [cornerSizeIdx, mounted]);

  // Drag (corner only)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, elX: 0, elY: 0 });

  // Suppress time updates sau khi seek để tránh giật thanh progress
  const seekSuppressUntilRef = useRef(0);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(MUTED_SESSION_KEY) === "false") setIsMuted(false);
    } catch {}
  }, []);

  useEffect(() => {
    if (dragPos && position === "corner") {
      const s = getClampedCornerSize(CORNER_SIZES[cornerSizeIdx]);
      const maxX = document.documentElement.clientWidth - s.w - 16;
      const maxY = window.innerHeight - s.h - 72; // 72px để hở đều như khi nhấn nút Bottom
      setDragPos({ x: Math.max(16, Math.min(maxX, dragPos.x)), y: Math.max(16, Math.min(maxY, dragPos.y)) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cornerSizeIdx]);

  useEffect(() => { if (position !== "corner") setDragPos(null); }, [position]);

  const fallbackDuration = useMemo(() => {
    if (!transcripts || transcripts.length === 0) return 0;
    return Math.max(...transcripts.map((t) => t.end_ms || 0)) / 1000;
  }, [transcripts]);

  const effectiveDuration = duration > 0 ? duration : fallbackDuration;

  // YouTube IFrame API — chỉ khởi tạo 1 lần, KHÔNG bao giờ destroy/recreate khi đổi position
  useEffect(() => {
    const doInit = () => {
      if (playerRef.current) return; // Đã init rồi
      playerRef.current = new (window as any).YT.Player("yt-player-iframe", {
        videoId,
        height: "100%",
        width: "100%",
        playerVars: {
          autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1,
          rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, cc_load_policy: 0, showinfo: 0,
        },
        events: {
          onReady: (event: any) => {
            setIsReady(true);
            const dur = event.target.getDuration();
            if (dur > 0) setDuration(dur);
            try {
              if (sessionStorage.getItem(MUTED_SESSION_KEY) !== "false") event.target.mute();
              else event.target.unMute();
            } catch { event.target.mute(); }
          },
          onStateChange: (event: any) => {
            const state = event.data;
            if (state === YT_PLAYING) {
              setIsPlaying(true);
              const dur = event.target.getDuration();
              if (dur > 0) setDuration(dur);
              startTimeTracking();
            } else if (state === YT_PAUSED || state === YT_ENDED) {
              setIsPlaying(false); stopTimeTracking();
            } else if (state === YT_BUFFERING) {
              startTimeTracking();
            }
          },
        },
      });
    };

    if ((window as any).YT && (window as any).YT.Player) {
      doInit();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      const firstScript = document.getElementsByTagName("script")[0];
      firstScript.parentNode?.insertBefore(tag, firstScript);
      (window as any).onYouTubeIframeAPIReady = doInit;
    }

    return () => {
      stopTimeTracking();
      if (playerRef.current) { try { playerRef.current.destroy(); } catch {} playerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const startTimeTracking = () => {
    stopTimeTracking();
    timeUpdateIntervalRef.current = setInterval(() => {
      // Suppress check — tránh giật khi YouTube chưa buffer xong sau seek
      if (Date.now() < seekSuppressUntilRef.current) return;
      const player = playerRef.current;
      if (!player || typeof player.getCurrentTime !== "function") return;
      const ct = player.getCurrentTime();
      setCurrentTime(ct);
      onTimeUpdateRef.current(ct * 1000);
    }, 250);
  };

  const stopTimeTracking = () => {
    if (timeUpdateIntervalRef.current) { clearInterval(timeUpdateIntervalRef.current); timeUpdateIntervalRef.current = null; }
  };

  useEffect(() => () => stopTimeTracking(), []);

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player || !isReady) return;
    try {
      const state = player.getPlayerState();
      if (state === YT_PLAYING) player.pauseVideo(); else player.playVideo();
    } catch {}
  }, [isReady]);

  const seekTo = useCallback((timeMs: number) => {
    const player = playerRef.current;
    if (!player || !isReady) return;
    const timeSec = timeMs / 1000;
    // Suppress time tracking 800ms — tránh interval đọc lại vị trí cũ
    seekSuppressUntilRef.current = Date.now() + 800;
    setCurrentTime(timeSec);
    onTimeUpdateRef.current(timeMs);
    player.seekTo(timeSec, true);
    try {
      const state = player.getPlayerState();
      if (state !== YT_PLAYING && state !== YT_BUFFERING) player.playVideo();
    } catch {}
  }, [isReady]);

  useEffect(() => {
    (window as any).__audioPlayerSeekTo = seekTo;
    (window as any).__audioPlayerTogglePlay = togglePlay;
    return () => { delete (window as any).__audioPlayerSeekTo; delete (window as any).__audioPlayerTogglePlay; };
  }, [seekTo, togglePlay]);

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = progressRef.current;
    if (!bar || !isReady || effectiveDuration <= 0) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * effectiveDuration * 1000);
  };

  const cycleSpeed = () => {
    const player = playerRef.current;
    if (!player || !isReady) return;
    const idx = SPEED_OPTIONS.indexOf(speed);
    const newSpeed = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    player.setPlaybackRate(newSpeed);
    setSpeed(newSpeed);
  };

  const toggleMute = () => {
    const player = playerRef.current;
    if (!player || !isReady) return;
    const next = !isMuted;
    if (next) player.mute(); else player.unMute();
    setIsMuted(next);
    try { sessionStorage.setItem(MUTED_SESSION_KEY, String(next)); } catch {}
  };

  const skip = (seconds: number) => {
    const player = playerRef.current;
    if (!player || !isReady) return;
    const ct = player.getCurrentTime();
    const target = Math.max(0, Math.min(effectiveDuration, ct + seconds));
    seekSuppressUntilRef.current = Date.now() + 800;
    setCurrentTime(target);
    onTimeUpdateRef.current(target * 1000);
    player.seekTo(target, true);
  };

  // DRAG (corner only)
  const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (position !== "corner") return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    const el = floatRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragStartRef.current = { mouseX: clientX, mouseY: clientY, elX: rect.left, elY: rect.top };

    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;
      const cx = "touches" in ev ? ev.touches[0].clientX : ev.clientX;
      const cy = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
      const s = getClampedCornerSize(CORNER_SIZES[cornerSizeIdx]);
      const maxX = document.documentElement.clientWidth - s.w - 16;
      const maxY = window.innerHeight - s.h - 72; // 72px để hở đều như khi nhấn nút Bottom
      setDragPos({
        x: Math.max(16, Math.min(maxX, dragStartRef.current.elX + (cx - dragStartRef.current.mouseX))),
        y: Math.max(16, Math.min(maxY, dragStartRef.current.elY + (cy - dragStartRef.current.mouseY))),
      });
    };
    const onEnd = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
  }, [position, cornerSizeIdx]);

  const cyclePosition = () => {
    setPosition((prev) => prev === "corner" ? "top" : prev === "top" ? "bottom" : "corner");
  };

  const cycleCornerSize = () => {
    setCornerSizeIdx((prev) => (prev + 1) % CORNER_SIZES.length);
  };

  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;

  // Position button UI
  // Icon size: nhỏ hơn ở corner mode
  const iconCls = position === "corner" ? "w-2.5 h-2.5" : "w-3 h-3";
  const positionIcon = position === "corner"
    ? <ArrowUp className={iconCls} />
    : position === "top"
    ? <ArrowDown className={iconCls} />
    : <Minimize2 className={iconCls} />;
  const positionTitle = position === "corner" ? "Lên trên (full)" : position === "top" ? "Xuống dưới (full)" : "Thu nhỏ góc";

  // === Container style — 1 div duy nhất, tính toán tọa độ tuyệt đối để animation mượt ===
  const containerClassName = useMemo(() => {
    const base = "fixed z-50 bg-black select-none overflow-hidden rounded-xl shadow-2xl border border-slate-700/50";
    if (position === "top") return `${base} origin-top`;
    if (position === "bottom") return `${base} origin-bottom`;
    return `${base} origin-bottom-right`;
  }, [position]);

  const containerStyle = useMemo((): React.CSSProperties => {
    // Tránh bị dính transition của left, top gây lag lúc kéo thả
    const transition = isDragging
      ? ""
      : "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)";

    if (!mounted || windowSize.w === 0) {
      return { right: "16px", bottom: "72px", width: "320px", height: "180px", transition: "none" };
    }

    const sw = windowSize.w;
    const sh = windowSize.h;
    
    // Top / Bottom
    const tbConf = TOP_BOTTOM_SIZES[cornerSizeIdx] || TOP_BOTTOM_SIZES[2];
    const maxW = sw >= 1536 ? tbConf.maxW : Math.min(1366, tbConf.maxW);
    let topBottomW = Math.min(sw, maxW);
    let topBottomH = topBottomW / (16 / 9);

    // Cân đối lại: Chiều cao tối đa phụ thuộc vào size (35%, 50%, 65% màn hình)
    const maxH = sh * tbConf.maxH;
    if (topBottomH > maxH) {
      topBottomH = maxH;
      topBottomW = topBottomH * (16 / 9);
    }

    if (position === "top") {
      return {
        left: `${(sw - topBottomW) / 2}px`,
        top: "16px", // Dịch xuống 16px để hở lề, không bị sát viền trên
        width: `${topBottomW}px`,
        height: `${topBottomH}px`,
        transition
      };
    }
    if (position === "bottom") {
      return {
        left: `${(sw - topBottomW) / 2}px`,
        top: `${sh - topBottomH - 72}px`, // 72px để hở ra một khoảng trên thanh audio
        width: `${topBottomW}px`,
        height: `${topBottomH}px`,
        transition
      };
    }

    // Corner
    const cWidth = cornerSize.w;
    const cHeight = cornerSize.h;
    if (dragPos) {
      return { left: `${dragPos.x}px`, top: `${dragPos.y}px`, width: `${cWidth}px`, height: `${cHeight}px`, transition };
    }
    return {
      left: `${sw - cWidth - 16}px`,
      top: `${sh - cHeight - 72}px`,
      width: `${cWidth}px`,
      height: `${cHeight}px`,
      transition
    };
  }, [position, dragPos, cornerSize, mounted, windowSize, isDragging]);

  // Button size class: nhỏ hơn ở corner
  const btnCls = position === "corner" ? "w-5 h-5" : "w-7 h-7";
  const btnTextCls = position === "corner" ? "text-[10px]" : "text-[10px]";
  const btnIconCls = position === "corner" ? "w-3 h-3" : "w-3.5 h-3.5";
  // Nút offset: corner dịch lên 2px
  const btnBarCls = position === "corner" ? "absolute top-[2px] right-1 z-20" : "absolute top-1.5 right-1.5 z-20";

  return (
    <>
      {/* Video container — 1 div duy nhất, đổi CSS thay vì re-mount */}
      <div
        ref={floatRef}
        className={containerClassName}
        style={{
          ...containerStyle,
          opacity: showVideo ? 1 : 0,
          transform: showVideo ? "scale(1)" : "scale(0.95)",
          pointerEvents: showVideo ? "auto" : "none",
          transition: [containerStyle.transition, "opacity 0.25s ease-out, transform 0.25s ease-out"].filter(Boolean).join(", "),
        }}
      >
        {/* Drag handle (corner only) */}
        {position === "corner" && (
          <div
            className="absolute top-0 left-0 right-0 h-7 z-20 cursor-grab active:cursor-grabbing flex items-center justify-center"
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
          >
            <div className="flex gap-1.5 opacity-80">
              <div className="w-1.5 h-1.5 bg-white/90 rounded-full shadow-sm" />
              <div className="w-1.5 h-1.5 bg-white/90 rounded-full shadow-sm" />
              <div className="w-1.5 h-1.5 bg-white/90 rounded-full shadow-sm" />
            </div>
          </div>
        )}

        {/* Control buttons */}
        <div className={`${btnBarCls} flex items-center gap-1`}>
          {/* Position */}
          <button
            onClick={cyclePosition}
            className={`${btnCls} bg-blue-600/80 hover:bg-blue-500 text-white rounded-full flex items-center justify-center transition-colors cursor-pointer`}
            title={positionTitle}
          >
            {positionIcon}
          </button>
          {/* Size (Tất cả vị trí đều có) */}
          <button
            onClick={cycleCornerSize}
            className={`${btnCls} bg-amber-600/80 hover:bg-amber-500 text-white rounded-full flex items-center justify-center ${btnTextCls} font-bold transition-colors cursor-pointer`}
            title={`Kích thước: ${CORNER_SIZES[cornerSizeIdx].label}`}
          >
            {CORNER_SIZES[(cornerSizeIdx + 1) % CORNER_SIZES.length].label}
          </button>
          {/* Hide */}
          <button
            onClick={() => setShowVideo(false)}
            className={`${btnCls} bg-rose-600/80 hover:bg-rose-500 text-white rounded-full flex items-center justify-center transition-colors cursor-pointer`}
            title="Ẩn video"
          >
            <X className={btnIconCls} />
          </button>
        </div>

        {/* Overlay che YouTube UI — click = play/pause */}
        <div className="absolute inset-0 z-10 cursor-pointer" onClick={togglePlay} />

        {/* YouTube iframe — div này KHÔNG bao giờ bị remove khỏi DOM */}
        <div id="yt-player-iframe" className="w-full h-full" />
      </div>

      {/* Audio control bar */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-[calc(1366px-2rem)] 2xl:max-w-[calc(1600px-2rem)] z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-lg border-x border-t border-slate-200 dark:border-slate-800 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <div className="w-full relative">
          {/* Progress bar */}
          <div
            ref={progressRef}
            onClick={handleProgressClick}
            className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 cursor-pointer group hover:h-2.5 transition-all"
          >
            <div
              className="h-full bg-gradient-to-r from-red-500 to-red-600 rounded-r-full relative transition-[width] duration-100"
              style={{ width: `${progressPercent}%` }}
            >
              <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white border-2 border-red-500 dark:border-red-400 rounded-full shadow-md scale-90 group-hover:scale-125 transition-transform cursor-pointer z-10" />
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between px-4 py-2">
            {/* Left: time */}
            <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400 w-24">
              <span>{formatTime(currentTime)}</span>
              <span>/</span>
              <span>{effectiveDuration > 0 ? formatTime(effectiveDuration) : "--:--"}</span>
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
                disabled={!isReady}
                className="p-2.5 bg-red-600 hover:bg-red-700 disabled:bg-slate-400 text-white rounded-full transition-colors shadow-md cursor-pointer disabled:cursor-not-allowed"
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
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

            {/* Right: speed + volume + video toggle */}
            <div className="flex items-center gap-2 w-28 justify-end">
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
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setShowVideo((v) => !v)}
                className={`p-1.5 transition-colors cursor-pointer ${
                  showVideo 
                    ? "text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" 
                    : "text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 animate-pulse"
                }`}
                title={showVideo ? "Ẩn video" : "Hiện video"}
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
