"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { 
  Plus, Search, Settings, Calendar, Pin, Star, Trash2, Mic, Volume2, 
  RotateCcw, Sliders, ChevronRight, X, AlertTriangle, Moon, Sun, ArrowRight,
  Users, Info, Rocket, LogIn, Lightbulb, LayoutGrid, Check, Minus, BookOpen, ChevronDown,
  ChevronUp, Upload, Link, FileAudio, Clipboard
} from "lucide-react";
import { validateAudioFile } from "@/lib/ai/audio-validator";

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
  const [visibleMeetingsCount, setVisibleMeetingsCount] = useState(15);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // New Meeting configuration states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingContext, setMeetingContext] = useState("general");
  const [sourceLanguage, setSourceLanguage] = useState("ja");
  const [targetLanguage, setTargetLanguage] = useState("vi");
  const [expectedSpeakers, setExpectedSpeakers] = useState<{ speaker_tag: string; display_name: string; language_code: string }[]>([
    { speaker_tag: "speaker_1", display_name: "Tôi", language_code: "auto" },
  ]);
  const [glossary, setGlossary] = useState<{ source: string; target: string; source_language: string; target_language: string }[]>([]);
  const [openSpeakerDropdown, setOpenSpeakerDropdown] = useState<number | null>(null);
  const isLoadedRef = useRef(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  // Create mode states (live / upload / youtube)
  const [createMode, setCreateMode] = useState<'live' | 'upload' | 'youtube'>('live');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  type Toast = { id: number; message: string; type: "success" | "error" | "info" };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToastId = useRef(0);

  const showCustomAlert = (message: string, type: "success" | "error" | "info" = "info", title: string = "Thông báo") => {
    return new Promise<void>((resolve) => {
      const id = nextToastId.current++;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        resolve();
      }, 3000);
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
        setExpectedSpeakers([{ speaker_tag: "speaker_1", display_name: "Tôi", language_code: "auto" }]);
      }
    } else {
      setExpectedSpeakers([{ speaker_tag: "speaker_1", display_name: "Tôi", language_code: "auto" }]);
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

  // Polling for processing meetings
  useEffect(() => {
    const hasProcessing = meetings.some(
      (m) => !["recording", "completed", "paused", "failed"].includes(m.status)
    );
    if (!hasProcessing) return;

    const interval = setInterval(async () => {
      try {
        const { data, error } = await supabase
          .from("meetings")
          .select(`
            id, title, status, progress, duration_ms, source_language, target_language, meeting_context, is_pinned, is_favorite, created_at,
            ai_summaries ( executive_summary ),
            meeting_metadata ( created_from )
          `)
          .order("created_at", { ascending: false });

        if (!error && data) {
          setMeetings(data);
        }
      } catch (err) {
        console.error("Polling fetch error:", err);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [meetings, supabase]);

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
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      setMeetingTitle(`Cuộc họp ngày ${year}/${month}/${day}`);
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

  // Reset pagination count when active tab changes
  useEffect(() => {
    setVisibleMeetingsCount(15);
  }, [activeTab]);

  // Scroll listener to toggle showScrollTop state
  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 300) {
        setShowScrollTop(true);
      } else {
        setShowScrollTop(false);
      }
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(event.target as Node)) {
        setShowStatusDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);


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
          id, title, status, progress, duration_ms, source_language, target_language, meeting_context, is_pinned, is_favorite, created_at,
          ai_summaries ( executive_summary ),
          meeting_metadata ( created_from )
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

  const getSummarySnippet = (text: string, query: string) => {
    if (!text || !query) return "";

    const removeAccents = (str: string) => {
      const map: { [key: string]: string } = {
        'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
        'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
        'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
        'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
        'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
        'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
        'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
        'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
        'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
        'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
        'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
        'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
        'đ': 'd',
        'À': 'A', 'Á': 'A', 'Ả': 'A', 'Ã': 'A', 'Ạ': 'A',
        'Ă': 'A', 'Ằ': 'A', 'Ắ': 'A', 'Ẳ': 'A', 'Ẵ': 'A', 'Ặ': 'A',
        'Â': 'A', 'Ầ': 'A', 'Ấ': 'A', 'Ẩ': 'A', 'Ẫ': 'A', 'Ậ': 'A',
        'È': 'E', 'É': 'E', 'Ẻ': 'E', 'Ẽ': 'E', 'Ẹ': 'E',
        'Ê': 'E', 'Ề': 'E', 'Ế': 'E', 'Ể': 'E', 'Ễ': 'E', 'Ệ': 'E',
        'Ì': 'I', 'Í': 'I', 'Ỉ': 'I', 'Ĩ': 'I', 'Ị': 'I',
        'Ò': 'O', 'Ó': 'O', 'Ỏ': 'O', 'Õ': 'O', 'Ọ': 'O',
        'Ô': 'O', 'Ồ': 'O', 'Ố': 'O', 'Ổ': 'O', 'Ỗ': 'O', 'Ộ': 'O',
        'Ơ': 'O', 'Ờ': 'O', 'Ớ': 'O', 'Ở': 'O', 'Ỡ': 'O', 'Ợ': 'O',
        'Ù': 'U', 'Ú': 'U', 'Ủ': 'U', 'Ũ': 'U', 'Ụ': 'U',
        'Ư': 'U', 'Ừ': 'U', 'Ứ': 'U', 'Ử': 'U', 'Ữ': 'U', 'Ự': 'U',
        'Ỳ': 'Y', 'Ý': 'Y', 'Ỷ': 'Y', 'Ỹ': 'Y', 'Ỵ': 'Y',
        'Đ': 'D'
      };
      return str.split('').map(char => map[char] || char).join('');
    };

    const cleanText = removeAccents(text).toLowerCase();
    const cleanQuery = removeAccents(query).toLowerCase();
    
    const index = cleanText.indexOf(cleanQuery);
    if (index === -1) return text.slice(0, 120) + (text.length > 120 ? "..." : "");
    
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + query.length + 60);
    
    let snippet = text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    return snippet;
  };

  // Run global search across transcripts, titles, and summaries using pg_trgm ILIKE query with unaccent support
  const runGlobalSearch = async () => {
    setIsSearchingGlobally(true);
    try {
      // 1. Search in transcripts
      const { data, error } = await supabase.rpc("search_transcripts", {
        search_term: searchQuery,
        start_date: startDate || null,
        end_date: endDate || null
      });

      if (error) throw error;

      // 2. Search in meeting titles
      let meetingsQuery = supabase
        .from("meetings")
        .select("id, title, created_at");
      
      if (startDate) {
        meetingsQuery = meetingsQuery.gte("created_at", startDate);
      }
      if (endDate) {
        meetingsQuery = meetingsQuery.lte("created_at", `${endDate}T23:59:59.999Z`);
      }

      const { data: titleMatches, error: titleError } = await meetingsQuery.ilike("title", `%${searchQuery}%`);
      if (titleError) console.error("Title search error:", titleError);

      // 3. Search in AI summaries
      let summariesQuery = supabase
        .from("ai_summaries")
        .select(`
          meeting_id,
          executive_summary,
          reprocessed_executive_summary,
          meetings!inner ( title, created_at )
        `)
        .or(`executive_summary.ilike.%${searchQuery}%,reprocessed_executive_summary.ilike.%${searchQuery}%`);
        
      if (startDate) {
        summariesQuery = summariesQuery.gte("meetings.created_at", startDate);
      }
      if (endDate) {
        summariesQuery = summariesQuery.lte("meetings.created_at", `${endDate}T23:59:59.999Z`);
      }

      const { data: summaryMatches, error: summaryError } = await summariesQuery;
      if (summaryError) console.error("Summary search error:", summaryError);

      // Group transcripts by meeting for nicer UI
      const grouped: { [key: string]: any } = {};
      data?.forEach((item: any) => {
        if (!grouped[item.meeting_id]) {
          grouped[item.meeting_id] = {
            meeting_id: item.meeting_id,
            title: item.meeting_title,
            created_at: item.meeting_created_at,
            matches: [],
          };
        }
        grouped[item.meeting_id].matches.push({
          text: item.corrected_text || item.original_text,
          translation: item.translated_text,
          start_ms: item.start_ms,
        });
      });

      // Merge title matches if not already in grouped results
      titleMatches?.forEach((m: any) => {
        if (!grouped[m.id]) {
          grouped[m.id] = {
            meeting_id: m.id,
            title: m.title,
            created_at: m.created_at,
            matches: [
              {
                text: "Khớp tiêu đề cuộc họp",
                translation: "",
                start_ms: 0,
                isTitleMatch: true,
              }
            ],
          };
        }
      });

      // Merge summary matches
      summaryMatches?.forEach((sm: any) => {
        const parentMeeting = sm.meetings;
        if (!parentMeeting) return;
        
        if (!grouped[sm.meeting_id]) {
          grouped[sm.meeting_id] = {
            meeting_id: sm.meeting_id,
            title: parentMeeting.title,
            created_at: parentMeeting.created_at,
            matches: [],
          };
        }
        
        const cleanQuery = searchQuery.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const matchInSummary = (text: string) => {
          if (!text) return false;
          const cleanText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
          return cleanText.includes(cleanQuery);
        };
        
        if (matchInSummary(sm.executive_summary)) {
          grouped[sm.meeting_id].matches.push({
            text: getSummarySnippet(sm.executive_summary, searchQuery),
            translation: "",
            start_ms: 0,
            isSummaryMatch: true,
          });
        } else if (matchInSummary(sm.reprocessed_executive_summary)) {
          grouped[sm.meeting_id].matches.push({
            text: getSummarySnippet(sm.reprocessed_executive_summary, searchQuery),
            translation: "",
            start_ms: 0,
            isSummaryMatch: true,
          });
        }
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
      await showCustomAlert("Xóa cuộc họp thành công!", "success");
    } catch (err) {
      console.error("Delete error:", err);
      await showCustomAlert("Không thể xóa cuộc họp. Vui lòng thử lại.", "error");
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
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    setMeetingTitle(`Cuộc họp ngày ${year}/${month}/${day} - ${hours}:${minutes}`);
    setMeetingContext("general");
    setSourceLanguage("auto");
    setTargetLanguage("vi");
    setExpectedSpeakers([
      { speaker_tag: "speaker_1", display_name: "Tôi", language_code: "auto" },
    ]);
    setGlossary([]);
    setEchoCancellation(true);
    setNoiseSuppression(true);
    setAutoGainControl(true);
    setChunkSize(100);
    stopMicTest();
    setCreateMode('live');
    setUploadFile(null);
    setYoutubeUrl('');
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

  // Upload audio file handler
  const handleUploadMeeting = async () => {
    if (!uploadFile) {
      await showCustomAlert("Vui lòng chọn file âm thanh.", "error");
      return;
    }
    if (!meetingTitle.trim()) {
      await showCustomAlert("Vui lòng điền tiêu đề cuộc họp.", "error");
      return;
    }

    const validation = validateAudioFile(uploadFile);
    if (!validation.valid) {
      await showCustomAlert(validation.error || "File không hợp lệ.", "error");
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("config", JSON.stringify({
        title: meetingTitle,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        meeting_context: meetingContext,
        speakers: expectedSpeakers,
        glossary,
      }));

      const res = await fetch("/api/meetings/upload-audio", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok || !data.meeting_id) {
        throw new Error(data.error || "Gặp lỗi khi upload file.");
      }

      // Store blob URL for playback on history page
      const blobUrl = URL.createObjectURL(uploadFile);
      sessionStorage.setItem(`audio_blob_${data.meeting_id}`, blobUrl);

      router.push(`/history/${data.meeting_id}`);
    } catch (err) {
      console.error("Upload meeting error:", err);
      await showCustomAlert(`Không thể xử lý file: ${String(err)}`, "error");
    } finally {
      setIsUploading(false);
    }
  };

  // YouTube URL handler
  const handleYoutubeMeeting = async () => {
    if (!youtubeUrl.trim()) {
      await showCustomAlert("Vui lòng nhập URL YouTube.", "error");
      return;
    }
    if (!meetingTitle.trim()) {
      await showCustomAlert("Vui lòng điền tiêu đề cuộc họp.", "error");
      return;
    }

    // Basic YouTube URL validation
    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/).+/;
    if (!ytRegex.test(youtubeUrl.trim())) {
      await showCustomAlert("URL YouTube không hợp lệ.", "error");
      return;
    }

    setIsUploading(true);
    try {
      const res = await fetch("/api/meetings/process-youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtube_url: youtubeUrl.trim(),
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
        throw new Error(data.error || "Gặp lỗi khi xử lý YouTube.");
      }

      router.push(`/history/${data.meeting_id}`);
    } catch (err) {
      console.error("YouTube meeting error:", err);
      await showCustomAlert(`Không thể xử lý YouTube: ${String(err)}`, "error");
    } finally {
      setIsUploading(false);
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

  // Filter meetings list by tabs and status
  const filteredMeetings = meetings.filter((m) => {
    if (activeTab === "pinned" && !m.is_pinned) return false;
    if (activeTab === "favorite" && !m.is_favorite) return false;
    if (statusFilter !== "all") {
      if (statusFilter === "processing") {
        const isPipelineProcessing = !["recording", "completed", "paused", "failed"].includes(m.status);
        if (!isPipelineProcessing) return false;
      } else {
        if (m.status !== statusFilter) return false;
      }
    }
    return true;
  });

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const formatDuration = (ms: number) => {
    if (!ms) return "0 phút";
    const mins = Math.round(ms / 60000);
    return `${mins} phút`;
  };

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;
    if (filteredMeetings.length <= visibleMeetingsCount) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleMeetingsCount((prev) => prev + 15);
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinel);
    return () => {
      if (sentinel) observer.unobserve(sentinel);
    };
  }, [filteredMeetings.length, visibleMeetingsCount]);
  const getFilterButtonStyles = () => {
    if (showStatusDropdown && statusFilter === "all") {
      return "bg-slate-100 dark:bg-slate-800 border-slate-300 text-slate-900 dark:border-slate-700 dark:text-slate-100";
    }
    
    switch (statusFilter) {
      case "recording":
        return "bg-red-50 text-red-650 border-red-200/60 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900/30";
      case "completed":
        return "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/40 dark:text-blue-455 dark:border-blue-900/30";
      case "paused":
        return "bg-purple-50 text-purple-705 border-purple-200/60 dark:bg-purple-950/40 dark:text-purple-400 dark:border-purple-900/30";
      case "failed":
        return "bg-rose-50 text-rose-750 border-rose-200/60 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/30";
      case "processing":
        return "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/40 dark:text-amber-455 dark:border-amber-900/30";
      default:
        return "bg-white text-slate-605 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800 dark:hover:bg-slate-800";
    }
  };

  const getClearButtonHoverStyles = () => {
    switch (statusFilter) {
      case "recording": return "hover:bg-red-200/60 dark:hover:bg-red-900/60 text-red-600 dark:text-red-400";
      case "completed": return "hover:bg-blue-200/60 dark:hover:bg-blue-900/60 text-blue-600 dark:text-blue-400";
      case "paused": return "hover:bg-purple-200/60 dark:hover:bg-purple-900/60 text-purple-600 dark:text-purple-400";
      case "failed": return "hover:bg-rose-200/60 dark:hover:bg-rose-900/60 text-rose-600 dark:text-rose-400";
      case "processing": return "hover:bg-amber-200/60 dark:hover:bg-amber-900/60 text-amber-600 dark:text-amber-400";
      default: return "";
    }
  };

  const highlightText = (text: string, query: string) => {
    if (!query || !text) return text;

    const removeAccents = (str: string) => {
      const map: { [key: string]: string } = {
        'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
        'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
        'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
        'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
        'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
        'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
        'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
        'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
        'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
        'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
        'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
        'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
        'đ': 'd',
        'À': 'A', 'Á': 'A', 'Ả': 'A', 'Ã': 'A', 'Ạ': 'A',
        'Ă': 'A', 'Ằ': 'A', 'Ắ': 'A', 'Ẳ': 'A', 'Ẵ': 'A', 'Ặ': 'A',
        'Â': 'A', 'Ầ': 'A', 'Ấ': 'A', 'Ẩ': 'A', 'Ẫ': 'A', 'Ậ': 'A',
        'È': 'E', 'É': 'E', 'Ẻ': 'E', 'Ẽ': 'E', 'Ẹ': 'E',
        'Ê': 'E', 'Ề': 'E', 'Ế': 'E', 'Ể': 'E', 'Ễ': 'E', 'Ệ': 'E',
        'Ì': 'I', 'Í': 'I', 'Ỉ': 'I', 'Ĩ': 'I', 'Ị': 'I',
        'Ò': 'O', 'Ó': 'O', 'Ỏ': 'O', 'Õ': 'O', 'Ọ': 'O',
        'Ô': 'O', 'Ồ': 'O', 'Ố': 'O', 'Ổ': 'O', 'Ỗ': 'O', 'Ộ': 'O',
        'Ơ': 'O', 'Ờ': 'O', 'Ớ': 'O', 'Ở': 'O', 'Ỡ': 'O', 'Ợ': 'O',
        'Ù': 'U', 'Ú': 'U', 'Ủ': 'U', 'Ũ': 'U', 'Ụ': 'U',
        'Ư': 'U', 'Ừ': 'U', 'Ứ': 'U', 'Ử': 'U', 'Ữ': 'U', 'Ự': 'U',
        'Ỳ': 'Y', 'Ý': 'Y', 'Ỷ': 'Y', 'Ỹ': 'Y', 'Ỵ': 'Y',
        'Đ': 'D'
      };
      return str.split('').map(char => map[char] || char).join('');
    };

    const cleanText = removeAccents(text).toLowerCase();
    const cleanQuery = removeAccents(query).toLowerCase();

    if (!cleanText.includes(cleanQuery)) {
      return text;
    }

    const queryLen = cleanQuery.length;
    const result: React.ReactNode[] = [];
    let lastIndex = 0;
    
    let index = cleanText.indexOf(cleanQuery);
    while (index !== -1) {
      if (index > lastIndex) {
        result.push(text.slice(lastIndex, index));
      }
      
      const matchedOriginalText = text.slice(index, index + queryLen);
      result.push(
        <mark key={index} className="bg-yellow-200 dark:bg-yellow-800 text-slate-900 dark:text-slate-100 px-0.5 rounded-sm font-semibold">
          {matchedOriginalText}
        </mark>
      );
      
      lastIndex = index + queryLen;
      index = cleanText.indexOf(cleanQuery, lastIndex);
    }
    
    if (lastIndex < text.length) {
      result.push(text.slice(lastIndex));
    }
    
    return <>{result}</>;
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
              className="flex items-center space-x-2 btn-flat-rainbow px-5 h-10 rounded-xl font-bold text-sm transition-all cursor-pointer"
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
        <section className="glass p-4 sm:py-3.5 sm:px-5 rounded-2xl shadow-lg shadow-indigo-500/5">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Tìm kiếm nội dung, từ khóa..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9.5 pr-9 h-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
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

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-sm text-slate-500 w-full lg:w-auto">
              <div className="flex-1 sm:flex-initial flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 h-10 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all">
                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 mr-2 shrink-0 uppercase tracking-wider">Từ:</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-transparent border-none p-0 focus:ring-0 outline-none text-slate-850 dark:text-slate-200 text-xs w-full cursor-pointer"
                />
              </div>
              <div className="flex-1 sm:flex-initial flex items-center bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 h-10 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all">
                <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 mr-2 shrink-0 uppercase tracking-wider">Đến:</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-transparent border-none p-0 focus:ring-0 outline-none text-slate-850 dark:text-slate-200 text-xs w-full cursor-pointer"
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
                  className="text-blue-500 hover:text-blue-600 font-semibold text-xs whitespace-nowrap ml-2 cursor-pointer w-full sm:w-auto text-center sm:text-left mt-2 sm:mt-0"
                >
                  Xóa bộ lọc
                </button>
              )}
            </div>
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
                    className="bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm transition-[background-color,border-color,box-shadow] duration-200 cursor-pointer space-y-3"
                  >
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold text-lg text-slate-950 dark:text-slate-100 group-hover:text-blue-500">
                        {highlightText(m.title, searchQuery)}
                      </h4>
                      <span className="text-xs text-slate-400">
                        {new Date(m.created_at).toLocaleDateString("vi-VN")}
                      </span>
                    </div>
                    <div className="space-y-2 pl-3 border-l-2 border-blue-500">
                      {m.matches.slice(0, 3).map((match: any, idx: number) => (
                        <div key={idx} className="text-sm">
                          {match.isTitleMatch ? (
                            <p className="text-slate-400 dark:text-slate-500 italic font-medium flex items-center space-x-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700" />
                              <span>{match.text}</span>
                            </p>
                          ) : match.isSummaryMatch ? (
                            <div className="space-y-0.5">
                              <span className="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-wider block">
                                Khớp trong tóm tắt AI
                              </span>
                              <p className="text-slate-800 dark:text-slate-200 font-medium">
                                "{highlightText(match.text, searchQuery)}"
                              </p>
                            </div>
                          ) : (
                            <>
                              <p className="text-slate-800 dark:text-slate-200 font-medium">
                                "{highlightText(match.text, searchQuery)}"
                              </p>
                              {match.translation && (
                                <p className="text-slate-400 dark:text-slate-400 italic">
                                  "{highlightText(match.translation, searchQuery)}"
                                </p>
                              )}
                            </>
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
            <div className="flex justify-between items-center border-b border-slate-200 dark:border-slate-800">
              <div className="flex">
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

              <div ref={statusDropdownRef} className="relative mb-2.5">
                <button
                  onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                  className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer select-none no-print ${getFilterButtonStyles()}`}
                >
                  {statusFilter !== "all" && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setStatusFilter("all");
                        setShowStatusDropdown(false);
                      }}
                      className={`mr-0.5 p-0.5 rounded-full transition-colors cursor-pointer ${getClearButtonHoverStyles()}`}
                    >
                      <X className="w-3 h-3" />
                    </span>
                  )}
                  <span>
                    {statusFilter === "all"
                      ? "Trạng thái"
                      : statusFilter === "recording"
                      ? "Trạng thái: Đang họp"
                      : statusFilter === "completed"
                      ? "Trạng thái: Đã xong"
                      : statusFilter === "paused"
                      ? "Trạng thái: Tạm dừng"
                      : statusFilter === "failed"
                      ? "Trạng thái: Lỗi xử lý"
                      : "Trạng thái: Đang xử lý"}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${showStatusDropdown ? "rotate-180" : ""}`} />
                </button>

                {showStatusDropdown && (
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-30 overflow-hidden py-0 animate-in fade-in slide-in-from-top-2 duration-150">
                    <button
                      onClick={() => {
                        setStatusFilter("all");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between border-b border-slate-100 dark:border-slate-800/60 ${
                        statusFilter === "all" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      <span>Tất cả trạng thái</span>
                      {statusFilter === "all" && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setStatusFilter("recording");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between ${
                        statusFilter === "recording" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                        <span>ĐANG HỌP</span>
                      </div>
                      {statusFilter === "recording" && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setStatusFilter("completed");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between ${
                        statusFilter === "completed" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-blue-500" />
                        <span>ĐÃ XONG</span>
                      </div>
                      {statusFilter === "completed" && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setStatusFilter("paused");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between ${
                        statusFilter === "paused" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-350"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-purple-500" />
                        <span>TẠM DỪNG</span>
                      </div>
                      {statusFilter === "paused" && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setStatusFilter("failed");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between ${
                        statusFilter === "failed" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-355"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-rose-600" />
                        <span>LỖI XỬ LÝ</span>
                      </div>
                      {statusFilter === "failed" && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setStatusFilter("processing");
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-medium transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between ${
                        statusFilter === "processing" ? "text-blue-600 dark:text-blue-450 font-semibold bg-blue-50/10 dark:bg-blue-950/10" : "text-slate-600 dark:text-slate-355"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500" />
                        <span>ĐANG XỬ LÝ</span>
                      </div>
                      {statusFilter === "processing" && <Check className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* LIST */}
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array.from({ length: 15 }).map((_, i) => (
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
              <div className="space-y-8 animate-in fade-in duration-500">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredMeetings.slice(0, visibleMeetingsCount).map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-col bg-white dark:bg-slate-900/60 rounded-2xl overflow-hidden shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_12px_24px_rgba(0,0,0,0.08)] dark:hover:shadow-[0_12px_24px_rgba(0,0,0,0.4)] hover:-translate-y-1 transition-all duration-300 ease-out group border border-slate-200/80 dark:border-slate-850 hover:border-blue-500/30 dark:hover:border-blue-500/30"
                    >
                      {(() => {
                        const createdFrom = Array.isArray(m.meeting_metadata)
                          ? m.meeting_metadata[0]?.created_from
                          : m.meeting_metadata?.created_from;

                        const typeLabel = createdFrom === "youtube"
                          ? "YOUTUBE"
                          : createdFrom === "upload"
                          ? "FILE UPLOAD"
                          : "TRỰC TIẾP";

                        const typeStyles = createdFrom === "youtube"
                          ? "bg-red-50 text-red-600 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900/30"
                          : createdFrom === "upload"
                          ? "bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900/30"
                          : "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900/30";

                        return (
                          <>
                            <div className="px-5 py-3 bg-slate-50/80 dark:bg-slate-900/40 border-b border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${
                                    m.status === "recording"
                                      ? "bg-red-50 text-red-650 border-red-200/60 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900/30 pulse"
                                      : m.status === "completed"
                                      ? "bg-blue-50 text-blue-700 border-blue-200/60 dark:bg-blue-950/40 dark:text-blue-450 dark:border-blue-900/30"
                                      : m.status === "paused"
                                      ? "bg-purple-50 text-purple-705 border-purple-200/60 dark:bg-purple-950/40 dark:text-purple-400 dark:border-purple-900/30"
                                      : m.status === "failed"
                                      ? "bg-rose-50 text-rose-750 border-rose-200/60 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/30"
                                      : "bg-amber-50 text-amber-700 border-amber-200/60 dark:bg-amber-950/40 dark:text-amber-450 dark:border-amber-900/30"
                                  }`}
                                >
                                  {m.status === "recording"
                                    ? "ĐANG HỌP"
                                    : m.status === "completed"
                                    ? "ĐÃ XONG"
                                    : m.status === "paused"
                                    ? "TẠM DỪNG"
                                    : m.status === "failed"
                                    ? "LỖI XỬ LÝ"
                                    : "ĐANG XỬ LÝ"}
                                </span>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${typeStyles}`}>
                                  {typeLabel}
                                </span>
                              </div>
                              <div className="flex space-x-1.5 no-print" onClick={(e) => e.stopPropagation()}>
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
                                <button
                                  onClick={() => deleteMeeting(m.id)}
                                  className="p-1.5 rounded-lg hover:bg-slate-200/50 dark:hover:bg-slate-800 text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>

                            <div
                              className="p-5 pt-4 flex-1 cursor-pointer space-y-3"
                              onClick={() => router.push(m.status === "completed" ? `/history/${m.id}` : `/meeting/${m.id}`)}
                            >
                              <div className="space-y-1">
                                <h4 className="font-bold text-lg leading-tight text-slate-900 group-hover:text-blue-600 dark:text-slate-100 dark:group-hover:text-blue-400 transition-colors">
                                  {highlightText(m.title, searchQuery)}
                                </h4>
                                <div className="text-[13px] font-medium text-slate-400 flex items-center space-x-2">
                                  <span>{formatDate(m.created_at)}</span>
                                  <span>•</span>
                                  <span>{formatDuration(m.duration_ms)}</span>
                                </div>
                              </div>

                              {m.status !== "completed" && m.status !== "recording" && m.status !== "paused" && (
                                <div className="space-y-2 pt-1">
                                  <div className="flex justify-between items-center text-xs">
                                    <span className="font-medium text-slate-500 dark:text-slate-400 truncate max-w-[80%]">
                                      {m.progress?.message || (m.status === "failed" ? "Gặp lỗi khi xử lý" : "Đang chuẩn bị...")}
                                    </span>
                                    <span className="font-bold text-blue-650 dark:text-blue-400">
                                      {m.progress?.percent !== undefined ? `${m.progress.percent}%` : m.status === "failed" ? "0%" : "0%"}
                                    </span>
                                  </div>
                                  <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                    <div
                                      className={`h-1.5 rounded-full transition-all duration-500 ${m.status === "failed" ? "bg-red-500" : "bg-blue-600 animate-pulse"}`}
                                      style={{ width: `${m.progress?.percent !== undefined ? m.progress.percent : 0}%` }}
                                    />
                                  </div>
                                </div>
                              )}

                              {(m.status === "completed" || m.status === "recording" || m.status === "paused") && (
                                <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3 leading-relaxed">
                                  {m.status === "recording"
                                    ? "Cuộc họp đang diễn ra. Thông tin hội thoại và tóm tắt sẽ hiển thị sau khi kết thúc."
                                    : m.ai_summaries?.executive_summary
                                    ? highlightText(m.ai_summaries.executive_summary, searchQuery)
                                    : "(Cuộc họp chưa được tóm tắt)"}
                                </p>
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ))}
                </div>

                <div ref={loadMoreSentinelRef} className="h-14 flex items-center justify-center">
                  {filteredMeetings.length > visibleMeetingsCount && (
                    <span className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></span>
                  )}
                </div>
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
            className="max-w-6xl w-full flex flex-col bg-white dark:bg-slate-900 border dark:border-slate-800 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] rounded-[2rem] overflow-hidden animate-in fade-in zoom-in-95 duration-300 h-[730px] max-h-[95vh]"
          >
            
            {/* Header */}
            <header className="flex justify-between items-center px-8 py-4 shrink-0 bg-white dark:bg-slate-900">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 rounded-xl flex items-center justify-center">
                  <LayoutGrid className="w-5 h-5" />
                </div>
                <div>
                  <h1 className="text-[20px] leading-none font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">Cấu hình Cuộc họp</h1>
                  <p className="text-[12px] text-slate-500 dark:text-slate-400 font-medium mt-1">Thiết lập các thông số trước khi bắt đầu</p>
                </div>
              </div>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-slate-200 rounded-full transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            {/* Mode Tabs with Sliding Transition */}
            <div className="relative flex p-1 bg-slate-100 dark:bg-slate-800/80 rounded-2xl mx-4 sm:mx-8 mb-2 shrink-0 border border-slate-200/50 dark:border-slate-800/30">
              {/* Sliding Background Indicator */}
              <div 
                className="absolute top-1 bottom-1 transition-all duration-300 ease-out bg-white dark:bg-slate-900 rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.05)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.3)] ring-1 ring-black/5 dark:ring-white/5"
                style={{
                  width: 'calc(33.333% - 6px)',
                  left: createMode === 'live' 
                    ? '4px' 
                    : createMode === 'upload' 
                      ? 'calc(33.333% + 2px)' 
                      : 'calc(66.666% + 0px)'
                }}
              />
              
              <button
                onClick={() => setCreateMode('live')}
                className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-[12px] font-bold transition-colors cursor-pointer select-none ${
                  createMode === 'live'
                    ? 'text-blue-600 dark:text-blue-450'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <Mic className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Ghi âm trực tiếp</span>
              </button>
              <button
                onClick={() => setCreateMode('upload')}
                className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-[12px] font-bold transition-colors cursor-pointer select-none ${
                  createMode === 'upload'
                    ? 'text-blue-600 dark:text-blue-450'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <Upload className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Tải lên File</span>
              </button>
              <button
                onClick={() => setCreateMode('youtube')}
                className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-[12px] font-bold transition-colors cursor-pointer select-none ${
                  createMode === 'youtube'
                    ? 'text-blue-600 dark:text-blue-450'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <Link className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Link Youtube</span>
              </button>
            </div>

            {/* Main Content Area - Bento Grid */}
            <main className="flex-1 overflow-y-auto custom-scrollbar px-8 pb-2 pt-1 bg-white dark:bg-slate-900">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 auto-rows-auto">
                
                {/* Block 1: Audio / Upload / YouTube (Span 4 cols, Row span 2) */}
                {createMode === 'live' && (
                <section className="lg:col-span-4 lg:row-span-2 bg-[#F0F7FF] dark:bg-blue-950/10 rounded-3xl p-3.5 flex flex-col gap-3 border border-blue-100/50 dark:border-blue-900/30">
                  <div className="flex items-center gap-2">
                    <div className="text-blue-600 bg-blue-100 dark:bg-blue-950/50 p-1.5 rounded-lg flex items-center justify-center">
                      <Mic className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-blue-900 dark:text-blue-300 uppercase tracking-wide">Thiết bị & Âm thanh</h2>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wide">Chọn Microphone</label>
                    <div className="relative">
                      <select
                        value={selectedDevice}
                        onChange={(e) => setSelectedDevice(e.target.value)}
                        className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-[#005bbf] focus:ring-0 focus:shadow-[0_4px_12px_rgba(0,91,191,0.1)] outline-none transition-all rounded-xl pl-3.5 pr-8 py-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200 cursor-pointer appearance-none"
                      >
                        {audioDevices.map((d) => (
                          <option key={d.deviceId} value={d.deviceId} className="dark:bg-slate-900 dark:text-slate-200">
                            {d.label || `Microphone ${d.deviceId.substr(0, 5)}`}
                          </option>
                        ))}
                        {audioDevices.length === 0 && <option value="" className="dark:bg-slate-900 dark:text-slate-200">Không tìm thấy thiết bị Microphone</option>}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-blue-400 pointer-events-none" />
                    </div>
                  </div>

                  <div className="bg-white/60 dark:bg-slate-950/40 p-3 rounded-xl border border-white dark:border-slate-800/40 flex flex-col gap-3">
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
                      <div className="flex-1 h-2 bg-blue-100 dark:bg-blue-950 rounded-full overflow-hidden">
                        <div
                          ref={micBarRef}
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: "0%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 bg-white/60 dark:bg-slate-950/40 p-3 rounded-xl border border-white dark:border-slate-800/40 flex-1">
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={echoCancellation} onChange={(e) => setEchoCancellation(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${echoCancellation ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-950 border-2 border-blue-200 dark:border-slate-800 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-300 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">Hủy tiếng vọng</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${noiseSuppression ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-950 border-2 border-blue-200 dark:border-slate-800 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-300 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">Chống ồn</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <input type="checkbox" checked={autoGainControl} onChange={(e) => setAutoGainControl(e.target.checked)} className="hidden" />
                      <div className={`flex items-center justify-center w-5 h-5 rounded-md transition-colors ${autoGainControl ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-950 border-2 border-blue-200 dark:border-slate-800 text-transparent'}`}>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                      <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-300 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">Tự động chỉnh âm (AGC)</span>
                    </label>
                  </div>

                  <div className="flex items-center justify-between bg-white/80 dark:bg-slate-950/60 p-3 rounded-xl border border-white dark:border-slate-800/60 mt-auto">
                    <div>
                      <span className="text-[13px] font-bold text-blue-900 dark:text-blue-300 block">Deepgram Chunk</span>
                      <span className="text-[11px] font-medium text-blue-600/70 dark:text-blue-400/70">Độ trễ phân tích</span>
                    </div>
                    <div className="flex items-center bg-white/80 dark:bg-slate-900 rounded-lg border border-blue-100/50 dark:border-blue-900/30 overflow-hidden shadow-sm">
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
                        className="w-7 h-8 flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors cursor-pointer select-none"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <input
                        type="number"
                        min={80}
                        max={150}
                        value={chunkSize}
                        onChange={(e) => setChunkSize(parseInt(e.target.value) || 100)}
                        className="w-10 text-center bg-transparent border-none focus:ring-0 p-0 text-[13px] font-bold text-blue-700 dark:text-blue-400 appearance-none outline-none [-moz-appearance:_textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
                        className="w-7 h-8 flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors cursor-pointer select-none"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </section>
                )}

                {createMode === 'upload' && (
                <section className="lg:col-span-4 lg:row-span-2 bg-[#F0F7FF] dark:bg-blue-950/10 rounded-3xl p-3.5 flex flex-col gap-3 border border-blue-100/50 dark:border-blue-900/30">
                  <div className="flex items-center gap-2">
                    <div className="text-blue-600 bg-blue-100 dark:bg-blue-950/50 p-1.5 rounded-lg flex items-center justify-center">
                      <Upload className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-blue-900 dark:text-blue-300 uppercase tracking-wide">Upload File Âm thanh / Video</h2>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,video/mp4,video/webm,video/quicktime,.mp3,.wav,.m4a,.mp4,.mov,.webm,.ogg,.flac"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;
                      setUploadFile(file);
                    }}
                  />

                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files?.[0] || null;
                      if (file) setUploadFile(file);
                    }}
                    className="flex-1 flex flex-col items-center justify-center gap-3 bg-white/60 dark:bg-slate-950/40 p-6 rounded-xl border-2 border-dashed border-blue-200 dark:border-blue-800/50 hover:border-blue-400 dark:hover:border-blue-600 transition-colors cursor-pointer group min-h-[180px]"
                  >
                    {uploadFile ? (
                      <>
                        <div className="w-12 h-12 bg-blue-100 dark:bg-blue-950/50 rounded-xl flex items-center justify-center">
                          <FileAudio className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="text-center">
                          <p className="text-[13px] font-bold text-slate-800 dark:text-slate-200 truncate max-w-[200px]">{uploadFile.name}</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{(uploadFile.size / (1024 * 1024)).toFixed(1)} MB</p>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); setUploadFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          className="text-[11px] font-bold text-red-500 hover:text-red-700 dark:hover:text-red-400 transition-colors cursor-pointer"
                        >
                          Xóa file
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="w-12 h-12 bg-blue-100 dark:bg-blue-950/50 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Upload className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="text-center">
                          <p className="text-[13px] font-bold text-slate-700 dark:text-slate-300">Kéo thả file vào đây</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">hoặc click để chọn file</p>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="bg-white/80 dark:bg-slate-950/60 p-3 rounded-xl border border-white dark:border-slate-800/60 mt-auto">
                    <p className="text-[11px] font-medium text-blue-600/70 dark:text-blue-400/70 text-center leading-normal">
                      Hỗ trợ: MP3, WAV, M4A, MP4, MOV, WebM, OGG, FLAC <br /> Tối đa 500MB
                    </p>
                  </div>
                </section>
                )}

                {createMode === 'youtube' && (
                <section className="lg:col-span-4 lg:row-span-2 bg-[#F0F7FF] dark:bg-blue-950/10 rounded-3xl p-3.5 flex flex-col gap-3 border border-blue-100/50 dark:border-blue-900/30">
                  <div className="flex items-center gap-2">
                    <div className="text-blue-600 bg-blue-100 dark:bg-blue-950/50 p-1.5 rounded-lg flex items-center justify-center">
                      <Link className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-blue-900 dark:text-blue-300 uppercase tracking-wide">YouTube URL</h2>
                  </div>

                  <div className="flex flex-col gap-3 flex-1">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wide">Đường dẫn video</label>
                      <div className="relative flex items-center">
                        <input
                          type="url"
                          value={youtubeUrl}
                          onChange={(e) => setYoutubeUrl(e.target.value)}
                          placeholder="https://www.youtube.com/watch?v=..."
                          className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-[#005bbf] focus:ring-0 focus:shadow-[0_4px_12px_rgba(0,91,191,0.1)] outline-none transition-all rounded-xl pl-3.5 pr-10 py-2.5 text-[13px] font-semibold text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-600"
                        />
                        <div className="absolute right-1.5 flex items-center justify-center">
                          {youtubeUrl ? (
                            <button
                              type="button"
                              onClick={() => setYoutubeUrl('')}
                              className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all cursor-pointer"
                              title="Xóa đường dẫn"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText();
                                  if (text) setYoutubeUrl(text);
                                } catch (err) {
                                  console.error("Không thể đọc từ clipboard:", err);
                                }
                              }}
                              className="w-7 h-7 flex items-center justify-center rounded-full text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-all cursor-pointer"
                              title="Dán từ Clipboard"
                            >
                              <Clipboard className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* YouTube Thumbnail Preview */}
                    {youtubeUrl && (() => {
                      const match = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
                      const videoId = match?.[1];
                      if (!videoId) return null;
                      return (
                        <div className="bg-white/60 dark:bg-slate-950/40 p-3 rounded-xl border border-white dark:border-slate-800/40 flex flex-col items-center gap-2">
                          <img
                            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                            alt="YouTube thumbnail"
                            className="w-full rounded-lg object-cover aspect-video"
                          />
                        </div>
                      );
                    })()}
                  </div>

                  <div className="bg-white/80 dark:bg-slate-950/60 p-3 rounded-xl border border-white dark:border-slate-800/60 mt-auto">
                    <p className="text-[11px] font-medium text-blue-600/70 dark:text-blue-400/70 text-center">
                      Hỗ trợ video YouTube công khai hoặc không công khai
                    </p>
                  </div>
                </section>
                )}

                {/* Block 2: Meeting Info (Span 8 cols, Row span 1) */}
                <section className="lg:col-span-8 bg-[#F0FDF4] dark:bg-emerald-950/10 rounded-3xl p-3.5 flex flex-col gap-3 border border-emerald-100/50 dark:border-emerald-900/30">
                  <div className="flex items-center gap-2">
                    <div className="text-emerald-600 bg-emerald-100 dark:bg-emerald-950/50 p-1.5 rounded-lg flex items-center justify-center">
                      <Info className="w-4 h-4" />
                    </div>
                    <h2 className="text-[13px] font-bold text-emerald-900 dark:text-emerald-300 uppercase tracking-wide">Thông tin Cuộc họp</h2>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Tiêu đề cuộc họp</label>
                      <input
                        type="text"
                        value={meetingTitle}
                        onChange={(e) => setMeetingTitle(e.target.value)}
                        className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl px-3 py-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200"
                      />
                    </div>
                    
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Ngữ cảnh (Context)</label>
                      <div className="relative">
                        <select
                          value={meetingContext}
                          onChange={(e) => setMeetingContext(e.target.value)}
                          className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200 cursor-pointer appearance-none"
                        >
                          <option value="general" className="dark:bg-slate-900 dark:text-slate-200">Họp chung (Giao tiếp thường nhật)</option>
                          <option value="factory" className="dark:bg-slate-900 dark:text-slate-200">Nhà máy sản xuất (Cơ khí, quy trình, QC)</option>
                          <option value="it" className="dark:bg-slate-900 dark:text-slate-200">Công nghệ thông tin (IT, lập trình, phần mềm)</option>
                          <option value="business" className="dark:bg-slate-900 dark:text-slate-200">Kinh doanh / Hợp đồng (Pháp lý, giá cả)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Ngôn ngữ chính</label>
                      <div className="relative">
                        <select
                          value={sourceLanguage}
                          onChange={(e) => setSourceLanguage(e.target.value)}
                          className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200 cursor-pointer appearance-none"
                        >
                          <option value="ja" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Nhật (ja)</option>
                          <option value="vi" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Việt (vi)</option>
                          <option value="en" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Anh (en)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Dịch sang ngôn ngữ</label>
                      <div className="relative">
                        <select
                          value={targetLanguage}
                          onChange={(e) => setTargetLanguage(e.target.value)}
                          className="w-full bg-white/80 dark:bg-slate-950/80 border border-white/50 dark:border-slate-800/80 focus:bg-white dark:focus:bg-slate-900 focus:border-emerald-500 focus:ring-0 focus:shadow-[0_4px_12px_rgba(16,185,129,0.1)] outline-none transition-all rounded-xl pl-3 pr-8 py-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200 cursor-pointer appearance-none"
                        >
                          <option value="vi" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Việt (vi)</option>
                          <option value="ja" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Nhật (ja)</option>
                          <option value="en" className="dark:bg-slate-900 dark:text-slate-200">Tiếng Anh (en)</option>
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                </section>

                {/* Block 3: People (Span 4 cols, Row span 1) */}
                <section className="lg:col-span-4 bg-[#FAF5FF] dark:bg-purple-950/10 rounded-3xl flex flex-col gap-3 border border-purple-100/50 dark:border-purple-900/30 p-3.5 h-[280px]">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="text-purple-600 bg-purple-100 dark:bg-purple-950/50 p-1.5 rounded-lg flex items-center justify-center">
                        <Users className="w-4 h-4" />
                      </div>
                      <h2 className="text-[13px] font-bold text-purple-900 dark:text-purple-300 uppercase tracking-wide">Người nói</h2>
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
                        <div key={idx} className={`flex items-center gap-3 bg-white/80 dark:bg-slate-950/60 p-1.5 pr-9 rounded-lg border border-white dark:border-slate-800/60 shadow-sm relative group transition-all ${openSpeakerDropdown === idx ? 'z-30 shadow-md border-purple-200' : 'z-0'}`}>
                          <div className={`w-7 h-7 rounded-md font-extrabold flex items-center justify-center text-[11px] shrink-0 ${idx === 0 ? 'bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300' : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400'}`}>
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0 flex items-center justify-between">
                            <input
                              type="text"
                              value={sp.display_name}
                              onChange={(e) => updateSpeaker(idx, "display_name", e.target.value)}
                              className="bg-transparent border-none focus:ring-0 p-0 text-[13px] font-bold text-slate-800 dark:text-slate-200 w-[55%] outline-none"
                            />
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setOpenSpeakerDropdown(openSpeakerDropdown === idx ? null : idx)}
                                className={`bg-transparent border-none p-0 text-[11px] font-bold uppercase text-right cursor-pointer flex items-center justify-end gap-0.5 outline-none ${idx === 0 ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-400'}`}
                              >
                                {sp.language_code === 'auto' ? 'AUTO' : sp.language_code === 'vi' ? 'TIẾNG VIỆT' : sp.language_code === 'ja' ? 'TIẾNG NHẬT' : 'TIẾNG ANH'}
                                <ChevronDown className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                              </button>
                              
                              {openSpeakerDropdown === idx && (
                                <>
                                  <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpenSpeakerDropdown(null)} />
                                  <div className="absolute right-0 mt-2 w-28 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-lg z-50 py-0.5 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
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
                                        className={`w-full text-left px-2 py-1.5 text-[11px] font-bold transition-colors cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 ${sp.language_code === lang.code ? 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/45' : 'text-slate-600 dark:text-slate-350'}`}
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
                        className="flex items-center gap-3 bg-white/50 dark:bg-slate-950/30 p-1.5 pr-3 rounded-lg border border-white/50 dark:border-slate-800/30 shadow-sm opacity-60 cursor-pointer hover:opacity-100 transition-opacity"
                      >
                        <div className="w-7 h-7 rounded-md bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-450 font-extrabold flex items-center justify-center text-[11px] shrink-0">
                          <Plus className="w-3 h-3" />
                        </div>
                        <div className="flex-1 min-w-0 flex items-center justify-between">
                          <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500 italic">Thêm người nói...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Block 4: Glossary (Span 4 cols, Row span 1) */}
                <section className="lg:col-span-4 bg-[#FFFBEB] dark:bg-amber-950/10 rounded-3xl flex flex-col gap-3 border border-amber-100/50 dark:border-amber-900/30 p-3.5 h-[280px]">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="text-amber-600 bg-amber-100 dark:bg-amber-950/50 p-1.5 rounded-lg flex items-center justify-center">
                        <BookOpen className="w-4 h-4" />
                      </div>
                      <h2 className="text-[13px] font-bold text-amber-900 dark:text-amber-300 uppercase tracking-wide">Từ điển riêng</h2>
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
                      <div key={idx} className="flex items-center justify-between bg-white/80 dark:bg-slate-950/60 px-2.5 py-1 rounded-md border border-white dark:border-slate-800/60 shadow-sm">
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
                            className="font-bold text-slate-800 dark:text-slate-200 text-[12px] bg-transparent border-none p-0 outline-none resize-none flex-1 min-w-0 overflow-hidden"
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
                            className="font-bold text-amber-700 dark:text-amber-400 text-[12px] bg-transparent border-none p-0 outline-none resize-none flex-1 min-w-0 overflow-hidden"
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

                  <div className="mt-auto bg-amber-100/50 dark:bg-amber-950/20 p-2.5 rounded-xl flex gap-2 items-start">
                    <Lightbulb className="text-amber-600 w-4.5 h-4.5 shrink-0" />
                    <p className="text-[11px] font-medium text-amber-900/80 dark:text-amber-300/80 leading-tight">Thêm các từ viết tắt để AI nhận diện và dịch chính xác hơn.</p>
                  </div>
                </section>
              </div>
            </main>

            {/* Footer */}
            <footer className="flex flex-col sm:flex-row justify-between items-center px-8 py-4 bg-white dark:bg-slate-900 shrink-0 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={resetSetupDefaults}
                className="flex items-center gap-2 text-slate-500 dark:text-slate-400 font-bold text-[12px] hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
              >
                <RotateCcw className="w-4.5 h-4.5" /> ĐẶT LẠI
              </button>
              
              <div className="flex gap-3 w-full sm:w-auto mt-4 sm:mt-0">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 sm:flex-none bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl px-5 py-2.5 font-bold text-[13px] hover:bg-slate-200 dark:hover:bg-slate-700 transition-all active:scale-95 cursor-pointer"
                >
                  HỦY BỎ
                </button>
                {createMode === 'live' && (
                <button
                  onClick={handleStartMeeting}
                  className="flex-1 sm:flex-none bg-[#005bbf] dark:bg-blue-600 text-white rounded-xl px-5 py-2.5 font-bold text-[13px] flex items-center justify-center gap-1.5 hover:bg-blue-700 dark:hover:bg-blue-500 transition-all active:scale-95 shadow-[0_10px_15px_-3px_rgba(0,91,191,0.3)] dark:shadow-[0_10px_15px_-3px_rgba(0,91,191,0.5)] cursor-pointer"
                >
                  VÀO PHÒNG HỌP <ArrowRight className="w-4 h-4" />
                </button>
                )}
                {createMode === 'upload' && (
                <button
                  onClick={handleUploadMeeting}
                  disabled={!uploadFile || isUploading}
                  className="flex-1 sm:flex-none bg-[#005bbf] dark:bg-blue-600 text-white rounded-xl px-5 py-2.5 font-bold text-[13px] flex items-center justify-center gap-1.5 hover:bg-blue-700 dark:hover:bg-blue-500 transition-all active:scale-95 shadow-[0_10px_15px_-3px_rgba(0,91,191,0.3)] dark:shadow-[0_10px_15px_-3px_rgba(0,91,191,0.5)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  {isUploading ? 'ĐANG XỬ LÝ...' : 'BẮT ĐẦU XỬ LÝ'} <ArrowRight className="w-4 h-4" />
                </button>
                )}
                {createMode === 'youtube' && (
                <button
                  onClick={handleYoutubeMeeting}
                  disabled={!youtubeUrl.trim() || isUploading}
                  className="flex-1 sm:flex-none bg-[#005bbf] dark:bg-blue-600 text-white rounded-xl px-5 py-2.5 font-bold text-[13px] flex items-center justify-center gap-1.5 hover:bg-blue-700 dark:hover:bg-blue-500 transition-all active:scale-95 shadow-[0_10px_15px_-3px_rgba(0,91,191,0.3)] dark:shadow-[0_10px_15px_-3px_rgba(0,91,191,0.5)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  {isUploading ? 'ĐANG XỬ LÝ...' : 'BẮT ĐẦU XỬ LÝ'} <ArrowRight className="w-4 h-4" />
                </button>
                )}
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
      
      {/* TOAST NOTIFICATIONS */}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center space-x-3 px-4 py-3 rounded-lg shadow-lg border animate-in slide-in-from-right-8 fade-in duration-300 min-w-[250px] max-w-sm ${
              t.type === "success"
                ? "bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-900/50"
                : t.type === "error"
                ? "bg-white dark:bg-slate-900 border-rose-200 dark:border-rose-900/50"
                : "bg-white dark:bg-slate-900 border-blue-200 dark:border-blue-900/50"
            }`}
          >
            {t.type === "success" && (
              <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400">
                <Check className="w-4 h-4" />
              </span>
            )}
            {t.type === "error" && (
              <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/30 dark:text-rose-400">
                <span className="font-bold text-sm">!</span>
              </span>
            )}
            {t.type === "info" && (
              <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 dark:bg-blue-950/30 dark:text-blue-400">
                <span className="font-bold text-sm">i</span>
              </span>
            )}
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {t.message}
            </p>
          </div>
        ))}
      </div>

       {showScrollTop && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 z-40 flex items-center justify-center w-11 h-11 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-full text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-500/20 shadow-md hover:shadow-lg transition-all duration-300 hover:-translate-y-1 active:translate-y-0 cursor-pointer animate-in fade-in slide-in-from-bottom-4 duration-300"
          title="Cuộn lên đầu trang"
        >
          <ChevronUp className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
