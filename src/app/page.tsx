"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { 
  Plus, Search, Settings, Calendar, Pin, Star, Trash2, Mic, Volume2, 
  RotateCcw, Sliders, ChevronRight, X, AlertTriangle, Moon, Sun, ArrowRight 
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
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [targetLanguage, setTargetLanguage] = useState("vi");
  const [expectedSpeakers, setExpectedSpeakers] = useState<{ speaker_tag: string; display_name: string; language_code: string }[]>([
    { speaker_tag: "speaker_0", display_name: "Tôi (Chủ tọa)", language_code: "vi" },
    { speaker_tag: "speaker_1", display_name: "Đối tác Nhật", language_code: "ja" },
  ]);
  const [glossary, setGlossary] = useState<{ source: string; target: string; source_language: string; target_language: string }[]>([
    { source: "NG", target: "不良", source_language: "en", target_language: "ja" },
  ]);

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

    fetchMeetings();
    checkUnfinishedMeeting();
  }, []);

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
    } else {
      stopMicTest();
    }
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
    if (!confirm("Bạn có chắc chắn muốn xóa cuộc họp này cùng toàn bộ biên bản hội thoại?")) return;
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

  // Pre-meeting Mic Test
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
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        setMicLevel(Math.min(100, Math.round((average / 128) * 100)));
        animationFrameRef.current = requestAnimationFrame(draw);
      };
      draw();
    } catch (err) {
      console.error("Mic test error:", err);
      alert("Không thể truy cập Microphone để thử nghiệm.");
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
      audioContextRef.current.close();
    }
    setMicLevel(0);
  };

  // Reset defaults for setup
  const resetSetupDefaults = () => {
    const today = new Date().toISOString().split("T")[0];
    setMeetingTitle(`Cuộc họp ngày ${today}`);
    setMeetingContext("general");
    setSourceLanguage("auto");
    setTargetLanguage("vi");
    setExpectedSpeakers([
      { speaker_tag: "speaker_0", display_name: "Tôi (Chủ tọa)", language_code: "vi" },
      { speaker_tag: "speaker_1", display_name: "Đối tác Nhật", language_code: "ja" },
    ]);
    setGlossary([
      { source: "NG", target: "不良", source_language: "en", target_language: "ja" },
    ]);
    setEchoCancellation(true);
    setNoiseSuppression(true);
    setAutoGainControl(true);
    setChunkSize(100);
    stopMicTest();
  };

  // Create meeting on database and route to Live Room
  const handleStartMeeting = async () => {
    if (!meetingTitle.trim()) {
      alert("Vui lòng điền tiêu đề cuộc họp.");
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

      // Store active meeting ID for recovery
      localStorage.setItem("active_meeting_id", data.meeting_id);
      localStorage.setItem("meeting_echo_cancellation", String(echoCancellation));
      localStorage.setItem("meeting_noise_suppression", String(noiseSuppression));
      localStorage.setItem("meeting_auto_gain_control", String(autoGainControl));
      localStorage.setItem("meeting_chunk_size", String(chunkSize));
      localStorage.setItem("meeting_device_id", selectedDevice);

      // Route to meeting room
      router.push(`/meeting/${data.meeting_id}`);
    } catch (err) {
      console.error("Create meeting error:", err);
      alert(`Không thể tạo cuộc họp: ${String(err)}`);
    }
  };

  // Add/Remove dynamic speakers
  const addSpeakerField = () => {
    const nextIdx = expectedSpeakers.length;
    setExpectedSpeakers([
      ...expectedSpeakers,
      { speaker_tag: `speaker_${nextIdx}`, display_name: `Speaker ${nextIdx}`, language_code: "auto" },
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
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => router.push("/")}>
            <img src="/logo.png" alt="Logo" className="w-8 h-8 rounded-md shadow-md shadow-indigo-500/10" />
            <span className="font-bold text-2xl tracking-tight text-blue-600 dark:text-blue-400">
              Antigravity Voice
            </span>
          </div>

          <div className="flex items-center space-x-4">
            <button
              onClick={toggleTheme}
              className="p-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
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

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 space-y-8">
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
                className="px-3 h-9 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md transition-colors"
              >
                Hủy bỏ nháp
              </button>
              <button
                onClick={executeRecovery}
                className="flex items-center space-x-1.5 px-3 h-9 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-md transition-colors shadow-sm"
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
              className="w-full pl-11 pr-4 h-12 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
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
                className="text-blue-500 hover:text-blue-600 font-medium"
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
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all ${
                  activeTab === "recent"
                    ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                }`}
              >
                Gần đây
              </button>
              <button
                onClick={() => setActiveTab("pinned")}
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all ${
                  activeTab === "pinned"
                    ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                }`}
              >
                Đã ghim
              </button>
              <button
                onClick={() => setActiveTab("favorite")}
                className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all ${
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
              <div className="py-24 text-center text-slate-400">Đang tải cuộc họp...</div>
            ) : filteredMeetings.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-24 text-center text-slate-400 rounded-xl">
                Không có cuộc họp nào được ghi nhận ở mục này.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredMeetings.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-col glass rounded-2xl overflow-hidden shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 hover:-translate-y-1 transition-all duration-300 group border border-indigo-500/5 hover:border-indigo-500/20"
                  >
                    <div
                      className="p-6 flex-1 cursor-pointer space-y-4"
                      onClick={() => router.push(m.status === "completed" ? `/history/${m.id}` : `/meeting/${m.id}`)}
                    >
                      <div className="flex items-start justify-between">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold tracking-wider ${
                            m.status === "recording"
                              ? "bg-red-50 text-red-600 dark:bg-red-950/20 dark:text-red-400 pulse"
                              : m.status === "completed"
                              ? "bg-green-50 text-green-600 dark:bg-green-950/20 dark:text-green-400"
                              : "bg-amber-50 text-amber-600 dark:bg-amber-950/20 dark:text-amber-400"
                          }`}
                        >
                          {m.status === "recording" ? "ĐANG HỌP" : m.status === "completed" ? "ĐÃ XONG" : "ĐANG XỬ LÝ"}
                        </span>
                        <div className="flex space-x-2 no-print" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => togglePin(m.id, m.is_pinned)}
                            className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                              m.is_pinned ? "text-blue-500" : "text-slate-400 hover:text-slate-600"
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5 fill-current" />
                          </button>
                          <button
                            onClick={() => toggleFavorite(m.id, m.is_favorite)}
                            className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                              m.is_favorite ? "text-amber-500" : "text-slate-400 hover:text-slate-600"
                            }`}
                          >
                            <Star className="w-3.5 h-3.5 fill-current" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <h4 className="font-semibold text-lg leading-tight text-slate-900 group-hover:text-blue-500 dark:text-slate-100 dark:group-hover:text-blue-400">
                          {m.title}
                        </h4>
                        <div className="text-xs text-slate-400 flex items-center space-x-2">
                          <span>{new Date(m.created_at).toLocaleDateString("vi-VN")}</span>
                          <span>•</span>
                          <span>{formatDuration(m.duration_ms)}</span>
                        </div>
                      </div>

                      <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3">
                        {m.ai_summaries?.executive_summary || "(Biên bản họp chưa được tóm tắt)"}
                      </p>
                    </div>

                    <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 dark:bg-slate-900/50 dark:border-slate-800 flex justify-between items-center text-xs">
                      <span className="text-slate-400 font-medium">
                        {m.source_language.toUpperCase()} ➔ {m.target_language.toUpperCase()}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMeeting(m.id);
                        }}
                        className="text-slate-400 hover:text-red-500 p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 p-8 flex flex-col gap-6 animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Title */}
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <Mic className="w-5 h-5 text-blue-500" />
                <h3 className="font-bold text-xl">Cấu hình Cuộc họp Mới</h3>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content Fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 overflow-y-auto pr-2">
              {/* Left Column: Device & Settings */}
              <div className="space-y-6">
                <div>
                  <h4 className="font-semibold text-sm uppercase tracking-wider text-slate-400 mb-3">1. Thiết bị &amp; Âm thanh</h4>
                  
                  {/* Select mic device */}
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Chọn Microphone</label>
                    <select
                      value={selectedDevice}
                      onChange={(e) => setSelectedDevice(e.target.value)}
                      className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    >
                      {audioDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Microphone ${d.deviceId.substr(0, 5)}`}
                        </option>
                      ))}
                      {audioDevices.length === 0 && <option value="">Không tìm thấy thiết bị Microphone</option>}
                    </select>

                    {/* Microphone Tester */}
                    <div className="flex items-center space-x-3 pt-2">
                      <button
                        onClick={startMicTest}
                        className={`flex items-center space-x-1.5 px-3 h-8 text-xs font-semibold border rounded-md transition-all ${
                          isTestingMic
                            ? "bg-red-500 text-white border-red-500 hover:bg-red-600"
                            : "bg-slate-50 text-slate-700 hover:bg-slate-100 border-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:border-slate-800"
                        }`}
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>{isTestingMic ? "Dừng kiểm tra" : "Thử Microphone"}</span>
                      </button>

                      {/* Decibel Indicator */}
                      <div className="flex-1 h-2.5 bg-slate-100 dark:bg-slate-950 rounded-full overflow-hidden relative">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-75"
                          style={{ width: `${micLevel}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Audio parameters */}
                <div className="space-y-4 pt-3 border-t border-slate-100 dark:border-slate-800/50">
                  <h5 className="font-semibold text-xs text-slate-500">Xử lý tín hiệu phần cứng</h5>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="flex items-center space-x-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={echoCancellation}
                        onChange={(e) => setEchoCancellation(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span>Hủy tiếng vọng</span>
                    </label>
                    <label className="flex items-center space-x-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={noiseSuppression}
                        onChange={(e) => setNoiseSuppression(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span>Chống ồn</span>
                    </label>
                    <label className="flex items-center space-x-2 text-sm cursor-pointer select-none col-span-2">
                      <input
                        type="checkbox"
                        checked={autoGainControl}
                        onChange={(e) => setAutoGainControl(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span>Tự động chỉnh âm lượng (AGC)</span>
                    </label>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">Deepgram Chunk Size (ms)</span>
                    <input
                      type="number"
                      min={80}
                      max={150}
                      value={chunkSize}
                      onChange={(e) => setChunkSize(parseInt(e.target.value) || 100)}
                      className="w-16 h-8 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 text-center"
                    />
                  </div>
                </div>

                {/* General Settings */}
                <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800/50">
                  <h4 className="font-semibold text-sm uppercase tracking-wider text-slate-400">2. Cấu hình Cuộc họp</h4>
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Tiêu đề cuộc họp</label>
                    <input
                      type="text"
                      placeholder="Tiêu đề cuộc họp..."
                      value={meetingTitle}
                      onChange={(e) => setMeetingTitle(e.target.value)}
                      className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Ngữ cảnh cuộc họp (Context)</label>
                    <select
                      value={meetingContext}
                      onChange={(e) => setMeetingContext(e.target.value)}
                      className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="general">Họp chung (Giao tiếp thường nhật)</option>
                      <option value="factory">Nhà máy sản xuất (Cơ khí, quy trình, QC)</option>
                      <option value="it">Công nghệ thông tin (IT, code, phát triển)</option>
                      <option value="business">Kinh doanh / Thương thảo (Hợp đồng, giá cả)</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Ngôn ngữ chính</label>
                      <select
                        value={sourceLanguage}
                        onChange={(e) => setSourceLanguage(e.target.value)}
                        className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      >
                        <option value="auto">Tự động phát hiện (Auto)</option>
                        <option value="vi">Tiếng Việt (vi)</option>
                        <option value="ja">Tiếng Nhật (ja)</option>
                        <option value="en">Tiếng Anh (en)</option>
                      </select>
                    </div>

                    <div className="space-y-3">
                      <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Dịch sang ngôn ngữ</label>
                      <select
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value)}
                        className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      >
                        <option value="vi">Tiếng Việt (vi)</option>
                        <option value="ja">Tiếng Nhật (ja)</option>
                        <option value="en">Tiếng Anh (en)</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Speakers & Glossary */}
              <div className="space-y-6 border-t md:border-t-0 md:border-l border-slate-100 dark:border-slate-800 md:pl-8">
                {/* Speakers Config */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h4 className="font-semibold text-sm uppercase tracking-wider text-slate-400">3. Danh sách Người nói</h4>
                    <button
                      onClick={addSpeakerField}
                      className="text-xs font-semibold text-blue-500 hover:text-blue-600 flex items-center space-x-0.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Thêm</span>
                    </button>
                  </div>

                  <div className="space-y-3 max-h-[200px] overflow-y-auto pr-1">
                    {expectedSpeakers.map((sp, idx) => (
                      <div key={idx} className="flex items-center space-x-2">
                        <span className="text-xs font-medium text-slate-400 select-none shrink-0 w-16">
                          Mã {sp.speaker_tag.replace("speaker_", "")}
                        </span>
                        <input
                          type="text"
                          placeholder="Tên người nói..."
                          value={sp.display_name}
                          onChange={(e) => updateSpeaker(idx, "display_name", e.target.value)}
                          className="flex-1 h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        />
                        <select
                          value={sp.language_code}
                          onChange={(e) => updateSpeaker(idx, "language_code", e.target.value)}
                          className="w-20 h-9 px-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        >
                          <option value="auto">Auto</option>
                          <option value="vi">Tiếng Việt</option>
                          <option value="ja">Tiếng Nhật</option>
                          <option value="en">Tiếng Anh</option>
                        </select>
                        <button
                          disabled={expectedSpeakers.length <= 1}
                          onClick={() => removeSpeakerField(idx)}
                          className="p-1.5 text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Glossary Config */}
                <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800/50">
                  <div className="flex justify-between items-center">
                    <h4 className="font-semibold text-sm uppercase tracking-wider text-slate-400">4. Từ điển tên riêng / Glossary</h4>
                    <button
                      onClick={addGlossaryField}
                      className="text-xs font-semibold text-blue-500 hover:text-blue-600 flex items-center space-x-0.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Thêm</span>
                    </button>
                  </div>

                  <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1">
                    {glossary.map((g, idx) => (
                      <div key={idx} className="flex items-center space-x-2">
                        <input
                          type="text"
                          placeholder="Từ gốc (ví dụ: NG)..."
                          value={g.source}
                          onChange={(e) => updateGlossary(idx, "source", e.target.value)}
                          className="flex-1 h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        />
                        <span className="text-slate-400 text-xs select-none">➔</span>
                        <input
                          type="text"
                          placeholder="Từ chuẩn (ví dụ: Không đạt)..."
                          value={g.target}
                          onChange={(e) => updateGlossary(idx, "target", e.target.value)}
                          className="flex-1 h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        />
                        <button
                          onClick={() => removeGlossaryField(idx)}
                          className="p-1.5 text-slate-400 hover:text-red-500"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {glossary.length === 0 && (
                      <p className="text-xs text-slate-400 italic text-center py-4">Chưa có từ điển glossary nào được thêm.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex justify-between items-center pt-4 border-t border-slate-100 dark:border-slate-800/50">
              <button
                onClick={resetSetupDefaults}
                className="flex items-center space-x-1.5 px-3 h-10 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-md transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Đặt lại mặc định</span>
              </button>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 h-10 border border-slate-200 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-md transition-colors"
                >
                  Hủy bỏ
                </button>
                <button
                  onClick={handleStartMeeting}
                  className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-500 text-white px-5 h-10 rounded-md font-medium text-sm transition-all shadow-sm"
                >
                  <Mic className="w-4 h-4" />
                  <span>Vào Phòng họp</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
