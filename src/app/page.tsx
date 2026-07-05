"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { 
  Plus, Search, Settings, Calendar, Pin, Star, Trash2, Mic, Volume2, 
  RotateCcw, Sliders, ChevronRight, X, AlertTriangle, Moon, Sun, ArrowRight,
  Users, Info, Rocket, LogIn, Lightbulb, LayoutGrid, Check, Minus, BookOpen, ChevronDown
} from "lucide-react";

export default function Dashboard() {
  const router = useRouter();
  const supabase = createClient();

  // Theme state
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Dashboard states
  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"recent" | "pinned" | "favorite">("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<any[]>([]);
  const [isSearchingGlobally, setIsSearchingGlobally] = useState(false);

  // New Meeting configuration states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingContext, setMeetingContext] = useState("general");
  const [sourceLanguage, setSourceLanguage] = useState("ja");
  const [targetLanguage, setTargetLanguage] = useState("vi");
  const [expectedSpeakers, setExpectedSpeakers] = useState<{ speaker_tag: string; display_name: string; language_code: string }[]>([
    { speaker_tag: "speaker_1", display_name: "Tôi", language_code: "ja" },
  ]);
  const [glossary, setGlossary] = useState<{ source: string; target: string; source_language: string; target_language: string }[]>([]);
  const [openSpeakerDropdown, setOpenSpeakerDropdown] = useState<number | null>(null);
  const isLoadedRef = useRef(false);

  // Custom Modal state
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: "info" | "confirm" | "success" | "error";
    onConfirm?: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    type: "info",
  });

  const showCustomAlert = (message: string, type: "success" | "error" | "info" = "info", title: string = "Thông báo") => {
    return new Promise<void>((resolve) => {
      setModalConfig({
        isOpen: true,
        title,
        message,
        type,
        onConfirm: () => {
          setModalConfig((prev) => ({ ...prev, isOpen: false }));
          resolve();
        },
      });
    });
  };

  const showCustomConfirm = (message: string, title: string = "Xác nhận") => {
    return new Promise<boolean>((resolve) => {
      setModalConfig({
        isOpen: true,
        title,
        message,
        type: "confirm",
        onConfirm: () => {
          setModalConfig((prev) => ({ ...prev, isOpen: false }));
          resolve(true);
        },
        onCancel: () => {
          setModalConfig((prev) => ({ ...prev, isOpen: false }));
          resolve(false);
        },
      });
    });
  };

  // Audio configuration
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [chunkSize, setChunkSize] = useState(100); // ms

  // Mic level testing states
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const testStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Meeting Recovery state
  const [recoveryMeeting, setRecoveryMeeting] = useState<{ id: string; title: string; created_at: string } | null>(null);

  // Initialize Theme and Fetch Data
  useEffect(() => {
    // Check Dark Mode
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "dark") {
      setIsDarkMode(true);
      document.documentElement.classList.add("dark");
    }

    // Load saved audio configuration if any
    const savedEcho = localStorage.getItem("meeting_echo_cancellation");
    if (savedEcho !== null) setEchoCancellation(savedEcho !== "false");
    const savedNoise = localStorage.getItem("meeting_noise_suppression");
    if (savedNoise !== null) setNoiseSuppression(savedNoise !== "false");
    const savedAGC = localStorage.getItem("meeting_auto_gain_control");
    if (savedAGC !== null) setAutoGainControl(savedAGC !== "false");
    const savedChunk = localStorage.getItem("meeting_chunk_size");
    if (savedChunk !== null) setChunkSize(parseInt(savedChunk) || 100);
    const savedDevice = localStorage.getItem("meeting_device_id");
    if (savedDevice !== null) setSelectedDevice(savedDevice);

    // Load saved expected speakers
    const savedSpeakers = localStorage.getItem("meeting_expected_speakers");
    if (savedSpeakers !== null) {
      try {
        setExpectedSpeakers(JSON.parse(savedSpeakers));
      } catch (e) {
        console.error("Failed to parse speakers", e);
        setExpectedSpeakers([{ speaker_tag: "speaker_1", display_name: "Tôi", language_code: "ja" }]);
      }
    } else {
      setExpectedSpeakers([{ speaker_tag: "speaker_1", display_name: "Tôi", language_code: "ja" }]);
    }

    // Load saved glossary
    const savedGlossary = localStorage.getItem("meeting_glossary");
    if (savedGlossary !== null) {
      try {
        setGlossary(JSON.parse(savedGlossary));
      } catch (e) {
        console.error("Failed to parse glossary", e);
        setGlossary([]);
      }
    } else {
      setGlossary([]);
    }

    isLoadedRef.current = true;
    fetchMeetings();
    checkUnfinishedMeeting();

    // Check if redirecting from another page to create meeting
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("create") === "true") {
      setShowCreateModal(true);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    return () => {
      stopChunkSizeChange();
    };
  }, []);

  // Save speakers & glossary to cache when updated
  useEffect(() => {
    if (!isLoadedRef.current) return;
    localStorage.setItem("meeting_expected_speakers", JSON.stringify(expectedSpeakers));
  }, [expectedSpeakers]);

  useEffect(() => {
    if (!isLoadedRef.current) return;
    localStorage.setItem("meeting_glossary", JSON.stringify(glossary));
  }, [glossary]);

  // Enumerate devices when modal opens
  useEffect(() => {
    if (showCreateModal) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        setAudioDevices(audioInputs);
        if (audioInputs.length > 0) {
          setSelectedDevice(audioInputs[0].deviceId);
        }
      });
      // Set default title
      const today = new Date().toISOString().split("T")[0];
      setMeetingTitle(`Cuộc họp ngày ${today}`);
      setChunkSize(100);
    } else {
      stopMicTest();
    }
  }, [showCreateModal]);

  // Prevent background scrolling when modal is open
  useEffect(() => {
    if (showCreateModal) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [showCreateModal]);

  // Handle global search in transcripts
  useEffect(() => {
    if (!searchQuery.trim() && !startDate && !endDate) {
      setIsSearchingGlobally(false);
      return;
    }
    const delayDebounceFn = setTimeout(() => {
      runGlobalSearch();
    }, 400);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery, startDate, endDate]);

  const toggleTheme = () => {
    if (isDarkMode) {
      setIsDarkMode(false);
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    } else {
      setIsDarkMode(true);
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    }
  };

  const fetchMeetings = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("meetings")
        .select(`
          id, title, status, duration_ms, source_language, target_language, meeting_context, is_pinned, is_favorite, created_at,
          ai_summaries ( executive_summary )
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setMeetings(data || []);
    } catch (err) {
      console.error("Fetch meetings error:", err);
    } finally {
      setLoading(false);
    }
  };

  // Check if there is an unfinished meeting to recover
  const checkUnfinishedMeeting = async () => {
    const unfinishedMeetingId = localStorage.getItem("active_meeting_id");
    if (unfinishedMeetingId) {
      try {
        const { data, error } = await supabase
          .from("meetings")
          .select("id, title, created_at, status")
          .eq("id", unfinishedMeetingId)
          .single();

        if (!error && data && (data.status === "recording" || data.status === "processing")) {
          setRecoveryMeeting(data);
        }
      } catch (err) {
        console.error("Check unfinished meeting error:", err);
      }
    }
  };

  const discardRecovery = () => {
    if (recoveryMeeting) {
      localStorage.removeItem(`meeting_transcripts_${recoveryMeeting.id}`);
      localStorage.removeItem(`meeting_live_transcript_${recoveryMeeting.id}`);
    }
    localStorage.removeItem("active_meeting_id");
    setRecoveryMeeting(null);
  };

  const executeRecovery = () => {
    if (recoveryMeeting) {
      router.push(`/meeting/${recoveryMeeting.id}`);
    }
  };

  // Run global search across transcripts using pg_trgm ILIKE query
  const runGlobalSearch = async () => {
    setIsSearchingGlobally(true);
    try {
      let query = supabase
        .from("transcripts")
        .select(`
          id, original_text, corrected_text, translated_text, start_ms,
          meetings ( id, title, created_at )
        `);

      if (searchQuery.trim()) {
        query = query.or(`original_text.ilike.%${searchQuery}%,corrected_text.ilike.%${searchQuery}%,translated_text.ilike.%${searchQuery}%`);
      }

      if (startDate) {
        query = query.gte("created_at", `${startDate}T00:00:00Z`);
      }
      if (endDate) {
        query = query.lte("created_at", `${endDate}T23:59:59Z`);
      }

      const { data, error } = await query.limit(50);
      if (error) throw error;

      // Group transcripts by meeting for nicer UI
      const grouped: { [key: string]: any } = {};
      data?.forEach((item: any) => {
        const m = item.meetings;
        if (!m) return;
        if (!grouped[m.id]) {
          grouped[m.id] = {
            meeting_id: m.id,
            title: m.title,
            created_at: m.created_at,
            matches: [],
          };
        }
        grouped[m.id].matches.push({
          text: item.corrected_text || item.original_text,
          translation: item.translated_text,
          start_ms: item.start_ms,
        });
      });

      setGlobalSearchResults(Object.values(grouped));
    } catch (err) {
      console.error("Global search error:", err);
    }
  };

  // Actions for meetings list
  const togglePin = async (id: string, currentVal: boolean) => {
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ is_pinned: !currentVal })
        .eq("id", id);
      if (error) throw error;
      setMeetings(meetings.map((m) => (m.id === id ? { ...m, is_pinned: !currentVal } : m)));
    } catch (err) {
      console.error("Toggle pin error:", err);
    }
  };

  const toggleFavorite = async (id: string, currentVal: boolean) => {
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ is_favorite: !currentVal })
        .eq("id", id);
      if (error) throw error;
      setMeetings(meetings.map((m) => (m.id === id ? { ...m, is_favorite: !currentVal } : m)));
    } catch (err) {
      console.error("Toggle favorite error:", err);
    }
  };

  const deleteMeeting = async (id: string) => {
    const confirmed = await showCustomConfirm("Bạn có chắc chắn muốn xóa cuộc họp này cùng toàn bộ bản chi tiết hội thoại?");
    if (!confirmed) return;
    try {
      const { error } = await supabase.from("meetings").delete().eq("id", id);
      if (error) throw error;
      setMeetings(meetings.filter((m) => m.id !== id));
      if (recoveryMeeting?.id === id) {
        setRecoveryMeeting(null);
        localStorage.removeItem("active_meeting_id");
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  // Pre-meeting
  const micBarRef = useRef<HTMLDivElement>(null);

  const startMicTest = async () => {
    if (isTestingMic) {
      stopMicTest();
      return;
    }
    setIsTestingMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
      });
      testStreamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      let currentLevel = 0; // For LERP smoothing

      const draw = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const targetLevel = Math.min(100, (average / 128) * 100);
        
        // Mathematical smoothing (Linear Interpolation)
        currentLevel += (targetLevel - currentLevel) * 0.2;
        
        // Direct DOM manipulation bypasses React render for 60fps performance
        if (micBarRef.current) {
          micBarRef.current.style.width = `${Math.max(0, currentLevel)}%`;
        }

        animationFrameRef.current = requestAnimationFrame(draw);
      };
      
      analyserRef.current = analyser;
      draw();
    } catch (err) {
      console.error("Mic test error:", err);
      await showCustomAlert("Không thể truy cập Microphone để thử nghiệm.", "error");
      setIsTestingMic(false);
    }
  };

  const stopMicTest = () => {
    setIsTestingMic(false);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (testStreamRef.current) {
      testStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
    }
    if (micBarRef.current) {
      micBarRef.current.style.width = '0%';
    }
    setMicLevel(0);
  };

  // Long press for Deepgram Chunk size
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTouchDeviceRef = useRef(false);

  const startChunkSizeChange = (direction: "increment" | "decrement") => {
    const change = () => {
      setChunkSize((prev) => {
        if (direction === "increment") {
          return Math.min(150, prev + 10);
        } else {
          return Math.max(80, prev - 10);
        }
      });
    };

    change();

    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(change, 100);
    }, 400);
  };

  const stopChunkSizeChange = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleChunkSizeKeyDown = (e: React.KeyboardEvent, direction: "increment" | "decrement") => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setChunkSize((prev) => {
        if (direction === "increment") {
          return Math.min(150, prev + 10);
        } else {
          return Math.max(80, prev - 10);
        }
      });
    }
  };

  // Reset defaults for setup
  const resetSetupDefaults = () => {
    const today = new Date().toISOString().split("T")[0];
    setMeetingTitle(`Cuộc họp ngày ${today}`);
    setMeetingContext("general");
    setSourceLanguage("auto");
    setTargetLanguage("vi");
    setExpectedSpeakers([
      { speaker_tag: "speaker_1", display_name: "Tôi", language_code: "ja" },
    ]);
    setGlossary([]);
    setEchoCancellation(true);
    setNoiseSuppression(true);
    setAutoGainControl(true);
    setChunkSize(100);
    stopMicTest();
  };

  // Create meeting on database and route to Live Room
  const handleStartMeeting = async () => {
    if (!meetingTitle.trim()) {
      await showCustomAlert("Vui lòng điền tiêu đề cuộc họp.", "error");
      return;
    }

    try {
      stopMicTest();
      const res = await fetch("/api/start-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: meetingTitle,
          source_language: sourceLanguage,
          target_language: targetLanguage,
          meeting_context: meetingContext,
          speakers: expectedSpeakers,
          glossary,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.meeting_id) {
        throw new Error(data.error || "Gặp lỗi khi tạo cuộc họp");
      }

      localStorage.setItem("meeting_echo_cancellation", String(echoCancellation));
      localStorage.setItem("meeting_noise_suppression", String(noiseSuppression));
      localStorage.setItem("meeting_auto_gain_control", String(autoGainControl));
      localStorage.setItem("meeting_chunk_size", String(chunkSize));
      localStorage.setItem("meeting_device_id", selectedDevice);

      // Route to meeting room
      router.push(`/meeting/${data.meeting_id}`);
    } catch (err) {
      console.error("Create meeting error:", err);
      await showCustomAlert(`Không thể tạo cuộc họp: ${String(err)}`, "error");
    }
  };

  const addSpeakerField = () => {
    let maxIdx = 1;
    expectedSpeakers.forEach((sp) => {
      const match = sp.speaker_tag.match(/speaker_(\d+)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num > maxIdx) maxIdx = num;
      }
    });
    const nextIdx = maxIdx + 1;
    setExpectedSpeakers([
      ...expectedSpeakers,
      { speaker_tag: `speaker_${nextIdx}`, display_name: `Speaker ${nextIdx}`, language_code: "ja" },
    ]);
  };

  const removeSpeakerField = (index: number) => {
    if (expectedSpeakers.length <= 1) return;
    setExpectedSpeakers(expectedSpeakers.filter((_, idx) => idx !== index));
  };

  const updateSpeaker = (index: number, key: string, val: string) => {
    setExpectedSpeakers(
      expectedSpeakers.map((sp, idx) => (idx === index ? { ...sp, [key]: val } : sp))
    );
  };

  // Add/Remove glossary
  const addGlossaryField = () => {
    setGlossary([...glossary, { source: "", target: "", source_language: "auto", target_language: targetLanguage }]);
  };

  const removeGlossaryField = (index: number) => {
    setGlossary(glossary.filter((_, idx) => idx !== index));
  };

  const updateGlossary = (index: number, key: string, val: string) => {
    setGlossary(
      glossary.map((g, idx) => (idx === index ? { ...g, [key]: val } : g))
    );
  };

  // Filter meetings list by tabs
  const filteredMeetings = meetings.filter((m) => {
    if (activeTab === "pinned") return m.is_pinned;
    if (activeTab === "favorite") return m.is_favorite;
    return true;
  });

  const formatDuration = (ms: number) => {
    if (!ms) return "0 phút";
    const mins = Math.round(ms / 60000);
    return `${mins} phút`;
  };

  return (
    <div className={`min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans`}>
      {/* HEADER */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => router.push("/")}>
            <img src="/logo.png" alt="Logo" className="w-8 h-8 object-contain" />
            <span className="font-bold text-2xl tracking-tight text-blue-600 dark:text-blue-400">
              NOTE AIPRO
            </span>
          </div>

          <div className="flex items-center space-x-4">
            <button
              onClick={toggleTheme}
              className="p-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center space-x-2 bg-mesh hover:bg-mesh-hover text-white px-4 h-10 rounded-md font-semibold text-sm transition-all shadow-md shadow-indigo-500/15 hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Tạo Cuộc Họp Mới</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-8 space-y-8">
        {/* RECOVERY POPUP */}
        {recoveryMeeting && (
          <div className="border border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20 p-4 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
            <div className="flex items-start space-x-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-amber-950 dark:text-amber-300">Phát hiện cuộc họp chưa kết thúc!</h4>
                <p className="text-sm text-amber-800 dark:text-amber-400">
                  Cuộc họp <strong>"{recoveryMeeting.title}"</strong> của bạn đã bị ngắt quãng đột ngột. Bạn có muốn tiếp tục?
                </p>
              </div>
            </div>
            <div className="flex space-x-3 shrink-0">
              <button
                onClick={discardRecovery}
                className="px-3 h-9 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md transition-colors cursor-pointer"
              >
                Hủy bỏ nháp
              </button>
              <button
                onClick={executeRecovery}
                className="flex items-center space-x-1.5 px-3 h-9 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-md transition-colors shadow-sm cursor-pointer"
              >
                <span>Khôi phục họp</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* SEARCH AND FILTERS */}
        <section className="glass p-6 rounded-2xl shadow-lg shadow-indigo-500/5 space-y-4">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm kiếm nội dung, từ khóa hoặc câu dịch trên tất cả các cuộc họp..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-10 h-12 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-full transition-colors cursor-pointer"
                title="Xóa tìm kiếm"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
            <div className="flex items-center space-x-2">
              <Calendar className="w-4 h-4" />
              <span>Từ ngày:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-2 h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center space-x-2">
              <span>Đến ngày:</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-2 h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {(searchQuery || startDate || endDate) && (
              <button
                onClick={() => {
                  setSearchQuery("");
                  setStartDate("");
                  setEndDate("");
                  setIsSearchingGlobally(false);
                }}
                className="text-blue-500 hover:text-blue-600 font-medium cursor-pointer"
              >
                Xóa bộ lọc
              </button>
            )}
          </div>
        </section>

        {/* RESULTS SECTION */}
        {isSearchingGlobally ? (
          <section className="space-y-4">
            <h3 className="font-semibold text-lg text-slate-800 dark:text-slate-200">
              Kết quả Tìm kiếm toàn cục ({globalSearchResults.length} cuộc họp khớp)
            </h3>
            {globalSearchResults.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-12 text-center text-slate-400 rounded-xl">
                Không tìm thấy câu phát biểu nào khớp với từ khóa tìm kiếm.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {globalSearchResults.map((m) => (
                  <div
                    key={m.meeting_id}
                    onClick={() => router.push(`/history/${m.meeting_id}`)}
                    className="bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm transition-all cursor-pointer space-y-3"
                  >
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold text-lg text-slate-950 dark:text-slate-100 group-hover:text-blue-500">
                        {m.title}
                      </h4>
                      <span className="text-xs text-slate-400">
                        {new Date(m.created_at).toLocaleDateString("vi-VN")}
                      </span>
                    </div>
                    <div className="space-y-2 pl-3 border-l-2 border-blue-500">
                      {m.matches.slice(0, 3).map((match: any, idx: number) => (
                        <div key={idx} className="text-sm">
                          <p className="text-slate-800 dark:text-slate-200 font-medium">
                            "{match.text}"
                          </p>
                          {match.translation && (
                            <p className="text-slate-400 italic">
                              "{match.translation}"
                            </p>
                          )}
                        </div>
                      ))}
                      {m.matches.length > 3 && (
                        <p className="text-xs text-blue-500 font-medium">
                          Xem thêm {m.matches.length - 3} câu khớp khác...
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="space-y-6">
            {/* TABS */}
            <div className="flex border-b border-slate-200 dark:border-slate-800">
              <button
                onClick={() => setActiveTab("recent")}
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all cursor-pointer ${
                  activeTab === "recent"
                    ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                }`}
              >
                Gần đây
              </button>
              <button
                onClick={() => setActiveTab("pinned")}
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all cursor-pointer ${
                  activeTab === "pinned"
                    ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                }`}
              >
                Đã ghim
              </button>
              <button
                onClick={() => setActiveTab("favorite")}
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all cursor-pointer ${
                  activeTab === "favorite"
                    ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                }`}
              >
                Yêu thích (★)
              </button>
            </div>

            {/* LIST */}
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="flex flex-col bg-white/50 dark:bg-slate-900/30 backdrop-blur-md rounded-2xl overflow-hidden shadow-sm border border-slate-200/50 dark:border-slate-800/50 p-6 space-y-4 animate-pulse"
                  >
                    <div className="flex justify-between items-center">
                      <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-16" />
                      <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-16" />
                    </div>
                    <div className="space-y-2">
                      <div className="h-5 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
                      <div className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
                    </div>
                    <div className="pt-2 flex justify-between items-center border-t border-slate-100 dark:border-slate-800/40">
                      <div className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded w-24" />
                      <div className="h-6 bg-slate-200 dark:bg-slate-800 rounded w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredMeetings.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-24 text-center text-slate-400 rounded-xl">
                Không có cuộc họp nào được ghi nhận ở mục này.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredMeetings.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-col bg-white/70 dark:bg-slate-900/50 backdrop-blur-md rounded-2xl overflow-hidden shadow-sm hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-1.5 transition-all duration-500 ease-out group border border-white/50 dark:border-slate-800 hover:border-blue-500/30"
                  >
                    <div
                      className="p-6 flex-1 cursor-pointer space-y-4"
                      onClick={() => router.push(m.status === "completed" ? `/history/${m.id}` : `/meeting/${m.id}`)}
                    >
                      <div className="flex items-start justify-between">
                        <span
                          className={`px-2 py-0.5 rounded-md text-[11px] font-bold tracking-wider ${
                            m.status === "recording"
                              ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 pulse"
                              : m.status === "completed"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                              : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                          }`}
                        >
                          {m.status === "recording" ? "ĐANG HỌP" : m.status === "completed" ? "ĐÃ XONG" : "ĐANG XỬ LÝ"}
                        </span>
                        <div className="flex space-x-2 no-print" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => togglePin(m.id, m.is_pinned)}
                            className={`p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors cursor-pointer ${
                              m.is_pinned ? "text-blue-500" : "text-slate-400 hover:text-slate-600"
                            }`}
                          >
                            <Pin className="w-4 h-4 fill-current" />
                          </button>
                          <button
                            onClick={() => toggleFavorite(m.id, m.is_favorite)}
                            className={`p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors cursor-pointer ${
                              m.is_favorite ? "text-amber-500" : "text-slate-400 hover:text-slate-600"
                            }`}
                          >
                            <Star className="w-4 h-4 fill-current" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <h4 className="font-bold text-lg leading-tight text-slate-900 group-hover:text-blue-600 dark:text-slate-100 dark:group-hover:text-blue-400 transition-colors">
                          {m.title}
                        </h4>
                        <div className="text-[13px] font-medium text-slate-400 flex items-center space-x-2">
                          <span>{new Date(m.created_at).toLocaleDateString("vi-VN")}</span>
                          <span>•</span>
                          <span>{formatDuration(m.duration_ms)}</span>
                        </div>
                      </div>

                      <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3 leading-relaxed">
                        {m.ai_summaries?.executive_summary || "(Cuộc họp chưa được tóm tắt)"}
                      </p>
                    </div>

                    <div className="px-6 py-4 bg-slate-100/50 border-t border-slate-200/50 dark:bg-slate-950/50 dark:border-slate-800/50 flex justify-between items-center text-xs">
                      <span className="text-slate-400 font-bold uppercase tracking-wider">
                        {m.source_language} ➔ {m.target_language}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMeeting(m.id);
                        }}
                        className="text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 rounded-lg transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* CREATE MEETING MODAL */}
      {showCreateModal && (
        <div 
          onClick={() => setShowCreateModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/40 backdrop-blur-sm"
        >
          {/* Main Modal Container - Bento Edition */}
          <div 
            onClick={(e) => e.stopPropagation()}
            className="max-w-6xl w-full flex flex-col bg-white shadow-[0_25px_50px_-12px_rgba(0,0,0,0.15)] rounded-[2rem] overflow-hidden animate-in fade-in zoom-in-95 duration-300 h-[680px] max-h-[95vh]"
          >
            
            {/* Header */}
            <header className="flex justify-between items-center px-8 py-5.5 shrink-0 bg-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center">
                  <LayoutGrid className="w-5 h-5" />
                </div>
                <div>
                  <h1 className="text-[20px] leading-none font-extrabold text-slate-900 tracking-tight">Cấu hình Cuộc họp</h1>
                  <p className="text-[12px] text-slate-500 font-medium mt-1">Thiết lập các thông số trước khi bắt đầu</p>
                </div>
              </div>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 flex items-center justify-center bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 rounded-full transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            {/* Main Content Area - Bento Grid */}
            <main className="flex-1 overflow-y-auto custom-scrollbar px-8 pb-2 pt-3 bg-white">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 auto-rows-auto">
                
                {/* Block 1: Audio (Span 4 cols, Row span 2) */}
                <section className="lg:col-span-4 lg:row-span-2 bg-[#F0F7FF] rounded-3xl p-3.5 flex flex-col gap-3 border border-blue-100/50">
                  <div className="flex items-center gap-2">
                    <div className="text-blue-600 bg-blue-100 p-1.5 rounded-lg flex items-center justify-center">
                      <Mic className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-blue-900 uppercase tracking-wide">Thiết bị & Âm thanh</h2>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold text-blue-700 uppercase tracking-wide">Chọn Microphone</label>
                    <div className="relative">
                      <select
                        value={selectedDevice}
                        onChange={(e) => setSelectedDevice(e.target.value)}
                        className="w-full bg-white/80 border border-white/50 focus:bg-white focus:border-[#005bbf] focus:ring-0 focus:shadow-[0_4px_12px_rgba(0,91,191,0.1)] outline-none transition-all rounded-xl pl-3.5 pr-8 py-2 text-[13px] font-semibold text-slate-800 cursor-pointer appearance-none"
                      >
                        {audioDevices.map((d) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Microphone ${d.deviceId.substr(0, 5)}`}
                          </option>
                        ))}
                        {audioDevices.length === 0 && <option value="">Không tìm thấy thiết bị Microphone</option>}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-blue-400 pointer-events-none" />
                    </div>
                  </div>

                  <div className="bg-white/60 p-3 rounded-xl border border-white flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={startMicTest}
                        className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all shadow-md active:scale-95 shrink-0 cursor-pointer ${
                          isTestingMic
                            ? "bg-red-600 text-white hover:bg-red-700 shadow-red-500/20"
                            : "bg-blue-600 text-white hover:bg-blue-700 shadow-blue-500/20"
                        }`}
                      >
                        <Mic className="w-4 h-4" />
                      </button>
                      <div className="flex-1 h-2 bg-blue-100 rounded-full overflow-hidden">
                        <div
                          ref={micBarRef}
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: "0%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 bg-white/60 p-3 rounded-xl border border-white flex-1">
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={echoCancellation} onChange={(e) => setEchoCancellation(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${echoCancellation ? 'bg-blue-600 text-white' : 'bg-white border-2 border-blue-200 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 group-hover:text-blue-700 transition-colors">Hủy tiếng vọng</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${noiseSuppression ? 'bg-blue-600 text-white' : 'bg-white border-2 border-blue-200 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 group-hover:text-blue-700 transition-colors">Chống ồn</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={autoGainControl} onChange={(e) => setAutoGainControl(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${autoGainControl ? 'bg-blue-600 text-white' : 'bg-white border-2 border-blue-200 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 group-hover:text-blue-700 transition-colors">Tự động chỉnh âm (AGC)</span>
                    </label>
                  </div>

                  <div className="flex items-center justify-between bg-white/80 p-3 rounded-xl border border-white mt-auto">
                    <div>
                      <span className="text-[13px] font-bold text-blue-900 block">Deepgram Chunk</span>
                      <span className="text-[11px] font-medium text-blue-600/70">Độ trễ phân tích</span>
                    </div>
                    <div className="flex items-center bg-white/80 rounded-lg border border-blue-100/50 overflow-hidden shadow-sm">
                      <button 
                        type="button"
                        onMouseDown={(e) => {
                          if (isTouchDeviceRef.current) return;
                          startChunkSizeChange("decrement");
                        }}
                        onMouseUp={stopChunkSizeChange}
                        onMouseLeave={stopChunkSizeChange}
                        onTouchStart={(e) => {
                          isTouchDeviceRef.current = true;
                          e.preventDefault();
                          startChunkSizeChange("decrement");
                        }}
                        onTouchEnd={stopChunkSizeChange}
                        onKeyDown={(e) => handleChunkSizeKeyDown(e, "decrement")}
                        className="w-7 h-8 flex items-center justify-center text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer select-none"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <input
                        type="number"
                        min={80}
                        max={150}
                        value={chunkSize}
                        onChange={(e) => setChunkSize(parseInt(e.target.value) || 100)}
                        className="w-10 text-center bg-transparent border-none focus:ring-0 p-0 text-[13px] font-bold text-blue-700 appearance-none outline-none [-moz-appearance:_textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button 
                        type="button"
                        onMouseDown={(e) => {
                          if (isTouchDeviceRef.current) return;
                          startChunkSizeChange("increment");
                        }}
                        onMouseUp={stopChunkSizeChange}
                        onMouseLeave={stopChunkSizeChange}
                        onTouchStart={(e) => {
                          isTouchDeviceRef.current = true;
                          e.preventDefault();
                          startChunkSizeChange("increment");
                        }}
                        onTouchEnd={stopChunkSizeChange}
                        onKeyDown={(e) => handleChunkSizeKeyDown(e, "increment")}
                        className="w-7 h-8 flex items-center justify-center text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer select-none"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </section>

                {/* Block 2: Meeting Info (Span 8 cols, Row span 1) */}
                <section className="lg:col-span-8 bg-[#F0FDF4] rounded-3xl p-3.5 flex flex-col gap-3 border border-emerald-100/50">
                  <div className="flex items-center gap-2">
                    <div className="text-emerald-600 bg-emerald-100 p-1.5 rounded-lg flex items-center justify-center">
                      <Info className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-emerald-900 uppercase tracking-wide">Thông tin Cuộc họp</h2>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">Tiêu đề cuộc họp</label>
                      <input
                        type="text"
                        value={meetingTitle}
                        onChange={(e) => setMeetingTitle(e.target.value)}
                        className="w-full bg-white/80 border border-white/50 focus:bg-white focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl px-3 py-2 text-[13px] font-semibold text-slate-800"
                      />
                    </div>
                    
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">Ngữ cảnh (Context)</label>
                      <div className="relative">
                        <select
                          value={meetingContext}
                          onChange={(e) => setMeetingContext(e.target.value)}
                          className="w-full bg-white/80 border border-white/50 focus:bg-white focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 cursor-pointer appearance-none"
                        >
                          <option value="general">Họp chung (Giao tiếp thường nhật)</option>
                          <option value="factory">Nhà máy sản xuất (Cơ khí, quy trình, QC)</option>
                          <option value="it">Công nghệ thông tin (IT, lập trình, phần mềm)</option>
                          <option value="business">Kinh doanh / Hợp đồng (Pháp lý, giá cả)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">Ngôn ngữ chính</label>
                      <div className="relative">
                        <select
                          value={sourceLanguage}
                          onChange={(e) => setSourceLanguage(e.target.value)}
                          className="w-full bg-white/80 border border-white/50 focus:bg-white focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 cursor-pointer appearance-none"
                        >
                          <option value="ja">Tiếng Nhật (ja)</option>
                          <option value="vi">Tiếng Việt (vi)</option>
                          <option value="en">Tiếng Anh (en)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">Dịch sang ngôn ngữ</label>
                      <div className="relative">
                        <select
                          value={targetLanguage}
                          onChange={(e) => setTargetLanguage(e.target.value)}
                          className="w-full bg-white/80 border border-white/50 focus:bg-white focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 cursor-pointer appearance-none"
                        >
                          <option value="vi">Tiếng Việt (vi)</option>
                          <option value="ja">Tiếng Nhật (ja)</option>
                          <option value="en">Tiếng Anh (en)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                </section>

                {/* Block 3: People (Span 4 cols, Row span 1) */}
                <section className="lg:col-span-4 bg-[#FAF5FF] rounded-3xl flex flex-col gap-3 border border-purple-100/50 p-3.5 h-[280px]">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="text-purple-600 bg-purple-100 p-1.5 rounded-lg flex items-center justify-center">
                        <Users className="w-4 h-4" />
                      </div>
                      <h2 className="text-[13px] font-bold text-purple-900 uppercase tracking-wide">Người nói</h2>
                    </div>
                    <button 
                      onClick={addSpeakerField}
                      className="w-7 h-7 flex items-center justify-center bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors shadow-sm shadow-purple-500/20 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex flex-col gap-1.5 flex-1 min-h-0">
                    <div className="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-2 flex-1">
                      {expectedSpeakers.map((sp, idx) => (
                        <div key={idx} className={`flex items-center gap-3 bg-white/80 p-1.5 pr-9 rounded-lg border border-white shadow-sm relative group transition-all ${openSpeakerDropdown === idx ? 'z-30 shadow-md border-purple-200' : 'z-0'}`}>
                          <div className={`w-7 h-7 rounded-md font-extrabold flex items-center justify-center text-[11px] shrink-0 ${idx === 0 ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>
                            {idx}
                          </div>
                          <div className="flex-1 min-w-0 flex items-center justify-between">
                            <input
                              type="text"
                              value={sp.display_name}
                              onChange={(e) => updateSpeaker(idx, "display_name", e.target.value)}
                              className="bg-transparent border-none focus:ring-0 p-0 text-[13px] font-bold text-slate-800 w-[55%] outline-none"
                            />
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setOpenSpeakerDropdown(openSpeakerDropdown === idx ? null : idx)}
                                className={`bg-transparent border-none p-0 text-[11px] font-bold uppercase text-right cursor-pointer flex items-center justify-end gap-0.5 outline-none ${idx === 0 ? 'text-purple-600' : 'text-slate-500'}`}
                              >
                                {sp.language_code === 'auto' ? 'AUTO' : sp.language_code === 'vi' ? 'TIẾNG VIỆT' : sp.language_code === 'ja' ? 'TIẾNG NHẬT' : 'TIẾNG ANH'}
                                <ChevronDown className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                              </button>
                              
                              {openSpeakerDropdown === idx && (
                                <>
                                  <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpenSpeakerDropdown(null)} />
                                  <div className="absolute right-0 mt-2 w-28 bg-white border border-slate-100 rounded-xl shadow-lg z-50 py-0.5 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                                    {[
                                      { code: 'auto', label: 'AUTO' },
                                      { code: 'vi', label: 'TIẾNG VIỆT' },
                                      { code: 'ja', label: 'TIẾNG NHẬT' },
                                      { code: 'en', label: 'TIẾNG ANH' }
                                    ].map((lang) => (
                                      <button
                                        key={lang.code}
                                        type="button"
                                        onClick={() => {
                                          updateSpeaker(idx, "language_code", lang.code);
                                          setOpenSpeakerDropdown(null);
                                        }}
                                        className={`w-full text-left px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer hover:bg-slate-50 ${sp.language_code === lang.code ? 'text-purple-600 bg-purple-50' : 'text-slate-600'}`}
                                      >
                                        {lang.label}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => removeSpeakerField(idx)}
                            disabled={expectedSpeakers.length <= 1}
                            className="w-5 h-5 flex items-center justify-center rounded-full bg-red-100 text-red-500 opacity-0 group-hover:opacity-100 disabled:opacity-0 hover:bg-red-200 transition-all absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer disabled:cursor-not-allowed"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      <div 
                        onClick={addSpeakerField}
                        className="flex items-center gap-3 bg-white/50 p-1.5 pr-3 rounded-lg border border-white/50 shadow-sm opacity-60 cursor-pointer hover:opacity-100 transition-opacity"
                      >
                        <div className="w-7 h-7 rounded-md bg-slate-100 text-slate-500 font-extrabold flex items-center justify-center text-[11px] shrink-0">
                          <Plus className="w-3 h-3" />
                        </div>
                        <div className="flex-1 min-w-0 flex items-center justify-between">
                          <span className="text-[12px] font-medium text-slate-400 italic">Thêm người nói...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Block 4: Glossary (Span 4 cols, Row span 1) */}
                <section className="lg:col-span-4 bg-[#FFFBEB] rounded-3xl flex flex-col gap-3 border border-amber-100/50 p-3.5 h-[280px]">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="text-amber-600 bg-amber-100 p-1.5 rounded-lg flex items-center justify-center">
                        <BookOpen className="w-4 h-4" />
                      </div>
                      <h2 className="text-[13px] font-bold text-amber-900 uppercase tracking-wide">Từ điển riêng</h2>
                    </div>
                    <button 
                      onClick={addGlossaryField}
                      className="w-7 h-7 flex items-center justify-center bg-amber-500 text-white rounded-md hover:bg-amber-600 transition-colors shadow-sm shadow-amber-500/20 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex flex-col gap-1 w-full flex-1 overflow-y-auto custom-scrollbar pr-2 content-start">
                    {glossary.map((g, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-white/80 px-2.5 py-1 rounded-md border border-white shadow-sm">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <textarea
                            rows={1}
                            value={g.source}
                            placeholder="Gốc"
                            onChange={(e) => {
                              e.target.style.height = 'auto';
                              e.target.style.height = e.target.scrollHeight + 'px';
                              updateGlossary(idx, "source", e.target.value);
                            }}
                            className="font-bold text-slate-800 text-[12px] bg-transparent border-none p-0 outline-none resize-none flex-1 min-w-0 overflow-hidden"
                            style={{ minHeight: '18px' }}
                          />
                          <ArrowRight className="text-amber-300 w-3.5 h-3.5 shrink-0" />
                          <textarea
                            rows={1}
                            value={g.target}
                            placeholder="Dịch"
                            onChange={(e) => {
                              e.target.style.height = 'auto';
                              e.target.style.height = e.target.scrollHeight + 'px';
                              updateGlossary(idx, "target", e.target.value);
                            }}
                            className="font-bold text-amber-700 text-[12px] bg-transparent border-none p-0 outline-none resize-none flex-1 min-w-0 overflow-hidden"
                            style={{ minHeight: '18px' }}
                          />
                        </div>
                        <button 
                          onClick={() => removeGlossaryField(idx)}
                          className="w-4.5 h-4.5 shrink-0 flex items-center justify-center rounded-full text-slate-400 hover:bg-red-100 hover:text-red-600 transition-colors ml-2 cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="mt-auto bg-amber-100/50 p-2.5 rounded-xl flex gap-2 items-start">
                    <Lightbulb className="text-amber-600 w-4.5 h-4.5 shrink-0" />
                    <p className="text-[11px] font-medium text-amber-900/80 leading-tight">Thêm các từ viết tắt để AI nhận diện và dịch chính xác hơn.</p>
                  </div>
                </section>
              </div>
            </main>

            {/* Footer */}
            <footer className="flex flex-col sm:flex-row justify-between items-center px-8 py-4 bg-white shrink-0 border-t border-slate-100">
              <button
                onClick={resetSetupDefaults}
                className="flex items-center gap-2 text-slate-500 font-bold text-[12px] hover:text-slate-800 hover:bg-slate-100 px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
              >
                <RotateCcw className="w-4.5 h-4.5" /> ĐẶT LẠI
              </button>
              
              <div className="flex gap-3 w-full sm:w-auto mt-4 sm:mt-0">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 sm:flex-none bg-slate-100 text-slate-700 rounded-xl px-5 py-2.5 font-bold text-[13px] hover:bg-slate-200 transition-all active:scale-95 cursor-pointer"
                >
                  HỦY BỎ
                </button>
                <button
                  onClick={handleStartMeeting}
                  className="flex-1 sm:flex-none bg-[#005bbf] text-white rounded-xl px-5 py-2.5 font-bold text-[13px] flex items-center justify-center gap-1.5 hover:bg-blue-700 transition-all active:scale-95 shadow-[0_10px_15px_-3px_rgba(0,91,191,0.3)] cursor-pointer"
                >
                  VÀO PHÒNG HỌP <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* CUSTOM MODAL */}
      {modalConfig.isOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 transition-all duration-300 animate-in fade-in"
          onClick={() => {
            if (modalConfig.onCancel) modalConfig.onCancel();
            else if (modalConfig.onConfirm) modalConfig.onConfirm();
          }}
        >
          <div 
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl w-full max-w-md p-6 transform transition-all duration-300 scale-in select-none text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 mb-4">
              <div className="flex items-center space-x-2">
                {modalConfig.type === "success" && (
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400">
                    <Check className="w-4 h-4" />
                  </span>
                )}
                {modalConfig.type === "error" && (
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/30 dark:text-rose-400">
                    <span className="font-bold text-sm">!</span>
                  </span>
                )}
                {modalConfig.type === "confirm" && (
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 dark:bg-blue-950/30 dark:text-blue-400">
                    <span className="font-bold text-sm">?</span>
                  </span>
                )}
                <h3 className="font-bold text-lg text-slate-800 dark:text-slate-200">{modalConfig.title}</h3>
              </div>
              <button 
                onClick={modalConfig.onCancel || modalConfig.onConfirm}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-md cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6 whitespace-pre-wrap">
              {modalConfig.message}
            </p>

            <div className="flex justify-end space-x-3">
              {modalConfig.type === "confirm" ? (
                <>
                  <button
                    onClick={modalConfig.onCancel}
                    className="px-4 py-2 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-350 transition-colors cursor-pointer"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={modalConfig.onConfirm}
                    className="px-4 py-2 bg-[#005bbf] hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                  >
                    Xác nhận
                  </button>
                </>
              ) : (
                <button
                  onClick={modalConfig.onConfirm}
                  className="px-4 py-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                >
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
