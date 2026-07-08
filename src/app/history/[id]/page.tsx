"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, use, Fragment, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { exportToDocx } from "@/lib/docx-helper";
import { exportToPdf } from "@/lib/pdf-helper";
import PipelineProgress from "@/components/PipelineProgress";
import AudioPlayer from "@/components/AudioPlayer";
import {
  ArrowLeft, FileText, Download, Play, RefreshCw, Edit2, Check, X,
  Search, Pin, Star, Trash2, Calendar, Clock, BookOpen, CheckSquare, Square, MessageSquare, Copy, Languages,
  Volume2, VolumeX, Moon, Sun, Plus, Sparkles, ChevronDown, List
} from "lucide-react";

// Chuyển Markdown (do AI trả về) thành HTML an toàn để hiển thị trong khung chat.
// Hỗ trợ tiêu đề (#..####), in đậm (**), code (`), danh sách (-/*, 1.) và đoạn văn.
function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t: string) =>
    t
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+?)`/g, '<code class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs">$1</code>');
  const lines = esc(src).split("\n");
  let html = "";
  let listTag: "ul" | "ol" | null = null;
  const closeList = () => { if (listTag) { html += `</${listTag}>`; listTag = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if (!line) { closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      closeList();
      html += `<div class="font-bold mt-2 mb-0.5">${inline(m[1])}</div>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (listTag !== "ul") { closeList(); html += `<ul class="list-disc pl-5 space-y-0.5">`; listTag = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (listTag !== "ol") { closeList(); html += `<ol class="list-decimal pl-5 space-y-0.5">`; listTag = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

interface HistoryDetailProps {
  params: Promise<{ id: string }>;
}

export default function HistoryDetail({ params }: HistoryDetailProps) {
  const { id: meetingId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  // Meeting states
  const [meeting, setMeeting] = useState<any>(null);
  const [speakers, setSpeakers] = useState<any[]>([]);
  const [transcripts, setTranscripts] = useState<any[]>([]); // Contains live transcripts
  const [reprocessedTranscripts, setReprocessedTranscripts] = useState<any[]>([]); // Contains reprocessed transcripts
  const [aiSummary, setAiSummary] = useState<any>(null);
  const [actionItems, setActionItems] = useState<any[]>([]); // Contains live action items
  const [reprocessedActionItems, setReprocessedActionItems] = useState<any[]>([]); // Contains reprocessed action items
  const [loading, setLoading] = useState(true);

  // UI state
  // 3 tab: transcript (có công tắc Bản gốc/Đã xử lý) | summary | ask.
  const [activeTab, setActiveTab] = useState<"transcript" | "summary" | "ask">("transcript");
  // Công tắc trong tab Transcript: "raw" = bản gốc STT, "ai" = bản đã xử lý (FINAL).
  const [transcriptVer, setTranscriptVer] = useState<"raw" | "ai">("raw");
  const verInitRef = useRef(false);
  // useDeferredValue: nội dung 100+ dòng render nặng -> nút/công tắc phản hồi tức thì.
  const shownTab = useDeferredValue(activeTab);
  const shownVer = useDeferredValue(transcriptVer);
  // Ánh xạ sang khối nội dung có sẵn:
  //   transcript + raw -> processed/transcript (RAW, `transcripts`)
  //   transcript + ai  -> raw/transcript       (FINAL, `reprocessedTranscripts`) + control panel
  //   summary          -> processed/summary
  //   ask              -> chặn riêng
  const mainTab: "processed" | "raw" = (shownTab === "transcript" && shownVer === "ai") ? "raw" : "processed";
  const subTabProcessed: "summary" | "transcript" = shownTab === "summary" ? "summary" : "transcript";
  const subTabRaw = "transcript" as string;
  // Mặc định công tắc: hiện "Đã xử lý" nếu đã có bản FINAL, ngược lại "Bản gốc". Chỉ set 1 lần sau khi tải.
  useEffect(() => {
    if (verInitRef.current) return;
    if (transcripts.length > 0 || reprocessedTranscripts.length > 0) {
      verInitRef.current = true;
      setTranscriptVer(reprocessedTranscripts.length > 0 ? "ai" : "raw");
    }
  }, [transcripts.length, reprocessedTranscripts.length]);
  // AI jobs + Ask AI chat state
  const [aiJobs, setAiJobs] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Tự động cuộn xuống cuối khi có tin nhắn mới, AI đang stream, hoặc khi mở tab Hỏi AI
  useEffect(() => {
    if (shownTab !== "ask") return;
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, shownTab]);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [activeSpeech, setActiveSpeech] = useState<{ id: string } | null>(null);

  // Load browser speechSynthesis voices
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const loadVoices = () => {
      setVoices(window.speechSynthesis.getVoices());
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  const allAvailableVoices = useMemo(() => {
    const targetLang = meeting?.target_language || "vi";
    return voices
      .filter((v) => v.lang.toLowerCase().startsWith(targetLang.toLowerCase()))
      .map((v) => {
        let cleanName = v.name.split(" - ")[0].replace(/\s*\(.*?\)\s*/g, "").trim();
        return { name: `${cleanName} (Hệ thống)`, value: v.name };
      });
  }, [voices, meeting?.target_language]);

  useEffect(() => {
    if (allAvailableVoices.length > 0) {
      const currentVoiceExists = allAvailableVoices.some((v) => v.value === selectedVoice);
      if (!currentVoiceExists) {
        setSelectedVoice(allAvailableVoices[0].value);
      }
    } else {
      setSelectedVoice("");
    }
  }, [allAvailableVoices, selectedVoice]);

  // Reprocessing state for raw transcript
  const [isReprocessingRaw, setIsReprocessingRaw] = useState(false);
  const [numSpeakers, setNumSpeakers] = useState<string>("auto");

  // Editing state for AI Summary (Live)
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedExecSummary, setEditedExecSummary] = useState("");
  const [editedDecisions, setEditedDecisions] = useState<string[]>([]);

  // Editing state for AI Summary (Reprocessed)
  const [isEditingReprocessedSummary, setIsEditingReprocessedSummary] = useState(false);
  const [editedReprocessedExecSummary, setEditedReprocessedExecSummary] = useState("");
  const [editedReprocessedDecisions, setEditedReprocessedDecisions] = useState<string[]>([]);

  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);

  // Editing state for transcripts lines
  const [editingTranscriptId, setEditingTranscriptId] = useState<string | null>(null);
  const [editingTextVal, setEditingTextVal] = useState("");

  // Audio player state (chỉ tồn tại trong phiên upload)
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [activeAudioTranscriptId, setActiveAudioTranscriptId] = useState<string | null>(null);

  // Speaker rename state
  const [renamingSpeaker, setRenamingSpeaker] = useState<{ tag: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  // Ref cho auto-scroll transcript
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const [isSavingLine, setIsSavingLine] = useState(false);

  // Custom Modal state
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    isClosing?: boolean;
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
  type Toast = { id: number; title: string; desc: string; type: "success" | "error" | "info" | "warning", closing?: boolean };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToastId = useRef(0);

  const removeToast = (id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  };

  const addToast = (title: string, desc: string, type: "success" | "error" | "info" | "warning" = "info") => {
    const id = nextToastId.current++;
    setToasts((prev) => [...prev, { id, title, desc, type }]);
    setTimeout(() => {
      removeToast(id);
    }, 4700);
  };

  const [copiedKey, setCopiedKey] = useState("");
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [activeTouchKey, setActiveTouchKey] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
    }
  }, []);

  useEffect(() => {
    if (!isTouchDevice) return;
    const handleDocumentClick = () => {
      setActiveTouchKey(null);
    };
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [isTouchDevice]);

  // Translation states for Summary & Decisions
  const [activeTranslateDropdown, setActiveTranslateDropdown] = useState<string | null>(null);
  const [translatedExecSummary, setTranslatedExecSummary] = useState<string>("");
  const [translatedDecisions, setTranslatedDecisions] = useState<string[]>([]);
  const [translatedReprocessedExecSummary, setTranslatedReprocessedExecSummary] = useState<string>("");
  const [translatedReprocessedDecisions, setTranslatedReprocessedDecisions] = useState<string[]>([]);
  const [translatedActionItems, setTranslatedActionItems] = useState<string[]>([]);
  const [translatedReprocessedActionItems, setTranslatedReprocessedActionItems] = useState<string[]>([]);
  const [translatingSection, setTranslatingSection] = useState<string | null>(null);

  const handleTranslateSection = async (section: string, lang: string) => {
    setActiveTranslateDropdown(null);
    if (lang === "original") {
      if (section === "live_summary") setTranslatedExecSummary("");
      if (section === "live_decisions") setTranslatedDecisions([]);
      if (section === "live_actions") setTranslatedActionItems([]);
      if (section === "raw_summary") setTranslatedReprocessedExecSummary("");
      if (section === "raw_decisions") setTranslatedReprocessedDecisions([]);
      if (section === "raw_actions") setTranslatedReprocessedActionItems([]);
      return;
    }

    setTranslatingSection(section);
    try {
      let textToTranslate = "";
      if (section === "live_summary") {
        textToTranslate = aiSummary?.executive_summary || "";
      } else if (section === "live_decisions") {
        textToTranslate = (aiSummary?.decisions || []).join("\n");
      } else if (section === "raw_summary") {
        textToTranslate = aiSummary?.reprocessed_executive_summary || "";
      } else if (section === "raw_decisions") {
        textToTranslate = (aiSummary?.reprocessed_decisions || []).join("\n");
      } else if (section === "live_actions") {
        textToTranslate = actionItems.map((item: any) => item.description).join("\n");
      } else if (section === "raw_actions") {
        textToTranslate = reprocessedActionItems.map((item: any) => item.description).join("\n");
      }

      if (!textToTranslate.trim()) {
        setTranslatingSection(null);
        return;
      }

      const res = await fetch("/api/translate-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToTranslate,
          sourceLang: "auto",
          targetLang: lang,
        }),
      });

      if (!res.ok) {
        throw new Error("Không thể dịch nội dung");
      }

      const data = await res.json();
      const translated = data.translatedText || "";

      if (section === "live_summary") {
        setTranslatedExecSummary(translated);
      } else if (section === "live_decisions") {
        // split by newline and filter empty items
        setTranslatedDecisions(translated.split("\n").filter((line: string) => line.trim().length > 0));
      } else if (section === "raw_summary") {
        setTranslatedReprocessedExecSummary(translated);
      } else if (section === "raw_decisions") {
        setTranslatedReprocessedDecisions(translated.split("\n").filter((line: string) => line.trim().length > 0));
      } else if (section === "live_actions") {
        setTranslatedActionItems(translated.split("\n").filter((line: string) => line.trim().length > 0));
      } else if (section === "raw_actions") {
        setTranslatedReprocessedActionItems(translated.split("\n").filter((line: string) => line.trim().length > 0));
      }
    } catch (err) {
      console.error(err);
      showCustomAlert("Gặp lỗi khi dịch nội dung. Vui lòng thử lại sau.", "error");
    } finally {
      setTranslatingSection(null);
    }
  };

  const [lineSummaries, setLineSummaries] = useState<Record<string, { originalSummary: string, translatedSummary: string, loading?: boolean }>>({});

  const handleSummarizeLine = async (lineId: string, originalText: string, translatedText: string) => {
    if (lineSummaries[lineId]) {
      const updated = { ...lineSummaries };
      delete updated[lineId];
      setLineSummaries(updated);
      return;
    }

    setLineSummaries((prev) => ({
      ...prev,
      [lineId]: { originalSummary: "", translatedSummary: "", loading: true },
    }));

    try {
      const res = await fetch("/api/summarize-line", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalText,
          translatedText,
          sourceLang: meeting?.source_language,
          targetLang: meeting?.target_language,
        }),
      });

      if (!res.ok) {
        throw new Error("Không thể tóm tắt dòng thoại");
      }

      const data = await res.json();
      setLineSummaries((prev) => ({
        ...prev,
        [lineId]: {
          originalSummary: data.originalSummary || originalText,
          translatedSummary: data.translatedSummary || translatedText,
          loading: false,
        },
      }));
    } catch (err) {
      console.error(err);
      showCustomAlert("Gặp lỗi khi tạo tóm tắt dòng thoại.", "error");
      setLineSummaries((prev) => {
        const updated = { ...prev };
        delete updated[lineId];
        return updated;
      });
    }
  };

  const renderTranslateDropdown = (section: string) => {
    return (
      <div className="relative">
        <button
          onClick={() => setActiveTranslateDropdown(activeTranslateDropdown === section ? null : section)}
          className="p-1.5 text-slate-400 hover:text-indigo-650 hover:bg-indigo-50 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-indigo-950/30 rounded transition-colors cursor-pointer shrink-0"
          title="Dịch nội dung"
        >
          <Languages className="w-4 h-4" />
        </button>
        {activeTranslateDropdown === section && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setActiveTranslateDropdown(null)} />
            <div className="absolute right-0 mt-1 w-32 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-30 text-xs text-left overflow-hidden ring-1 ring-black/5">
              <button
                onClick={() => handleTranslateSection(section, "vi")}
                className="w-full text-left px-3.5 py-2 hover:bg-indigo-50/70 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 font-medium cursor-pointer transition-colors"
              >
                Tiếng Việt
              </button>
              <button
                onClick={() => handleTranslateSection(section, "en")}
                className="w-full text-left px-3.5 py-2 hover:bg-indigo-50/70 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 font-medium cursor-pointer transition-colors"
              >
                English
              </button>
              <button
                onClick={() => handleTranslateSection(section, "ja")}
                className="w-full text-left px-3.5 py-2 hover:bg-indigo-50/70 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 font-medium cursor-pointer transition-colors"
              >
                日本語
              </button>
              <div className="border-t border-slate-100 dark:border-slate-800" />
              <button
                onClick={() => handleTranslateSection(section, "original")}
                className="w-full text-left px-3.5 py-2 hover:bg-rose-50/60 hover:text-rose-600 dark:hover:bg-rose-950/20 dark:hover:text-rose-400 text-slate-400 font-medium cursor-pointer transition-colors"
              >
                Bản gốc
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const showCustomAlert = (message: string, type: "success" | "error" | "info" = "info", title: string = "Thông báo") => {
    return new Promise<void>((resolve) => {
      setModalConfig({
        isOpen: true,
        isClosing: false,
        title,
        message,
        type,
        onConfirm: () => {
          setModalConfig((prev) => ({ ...prev, isClosing: true }));
          setTimeout(() => {
            setModalConfig((prev) => ({ ...prev, isOpen: false, isClosing: false }));
            resolve();
          }, 200);
        },
      });
    });
  };

  const showCustomConfirm = (message: string, title: string = "Xác nhận") => {
    return new Promise<boolean>((resolve) => {
      setModalConfig({
        isOpen: true,
        isClosing: false,
        title,
        message,
        type: "confirm",
        onConfirm: () => {
          setModalConfig((prev) => ({ ...prev, isClosing: true }));
          setTimeout(() => {
            setModalConfig((prev) => ({ ...prev, isOpen: false, isClosing: false }));
            resolve(true);
          }, 200);
        },
        onCancel: () => {
          setModalConfig((prev) => ({ ...prev, isClosing: true }));
          setTimeout(() => {
            setModalConfig((prev) => ({ ...prev, isOpen: false, isClosing: false }));
            resolve(false);
          }, 200);
        },
      });
    });
  };

  const handleCopyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 2000);
  };

  const toggleTheme = () => {
    const nextTheme = !isDarkMode;
    setIsDarkMode(nextTheme);
    if (nextTheme) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  };

  useEffect(() => {
    if (document.documentElement.classList.contains("dark")) {
      setIsDarkMode(true);
    }
    fetchMeetingData();

    // Load blob URL từ sessionStorage (chỉ có trong phiên upload)
    const blobUrl = sessionStorage.getItem(`audio_blob_${meetingId}`);
    if (blobUrl) {
      setAudioBlobUrl(blobUrl);
    }
  }, []);

  const fetchMeetingData = async () => {
    setLoading(true);
    try {
      // 1. Fetch meeting
      const { data: m, error: mErr } = await supabase
        .from("meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      if (mErr || !m) throw new Error("Meeting not found");
      setMeeting(m);

      // 2. Fetch speakers
      const { data: sps } = await supabase
        .from("speakers")
        .select("*")
        .eq("meeting_id", meetingId);
      setSpeakers(sps || []);

      // 3. Fetch transcripts
      const { data: txs } = await supabase
        .from("transcripts")
        .select(`
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, is_reprocessed, version_type, is_active,
          speakers ( display_name, color_hex, speaker_tag )
        `)
        .eq("meeting_id", meetingId)
        .order("start_ms", { ascending: true });

      if (txs) {
        // Alternating warm/hot and cold/cool colors for clear distinction
        const HOT_COLORS = ["#ea580c", "#dc2626", "#d97706", "#db2777"];
        const COLD_COLORS = ["#2563eb", "#4f46e5", "#0d9488", "#0891b2"];
        const uniqueSpeakerTags = Array.from(
          new Set(txs.map((t: any) => t.speakers?.speaker_tag || "speaker_1"))
        );
        const speakerToColorMap: { [tag: string]: string } = {};
        uniqueSpeakerTags.forEach((tag, idx) => {
          if (idx % 2 === 0) {
            speakerToColorMap[tag] = HOT_COLORS[Math.floor(idx / 2) % HOT_COLORS.length];
          } else {
            speakerToColorMap[tag] = COLD_COLORS[Math.floor(idx / 2) % COLD_COLORS.length];
          }
        });

        const allTranscripts = txs.map((t: any) => {
          const tag = t.speakers?.speaker_tag || "speaker_1";
          return {
            id: t.id,
            originalText: t.original_text,
            correctedText: t.corrected_text,
            translatedText: t.translated_text,
            speakerName: t.speakers?.display_name || "Unknown",
            speakerTag: tag,
            speakerColor: speakerToColorMap[tag] || t.speakers?.color_hex || "#64748b",
            startMs: t.start_ms,
            endMs: t.end_ms,
            confidence: t.confidence,
            isEdited: t.is_edited,
            editedText: t.edited_text,
            isReprocessed: t.is_reprocessed || false,
            versionType: t.version_type || "RAW"
          };
        });

        // Tách theo version_type (nguồn sự thật): RAW = bản gốc, FINAL = đã xử lý AI.
        setTranscripts(allTranscripts.filter((t: any) => t.versionType !== "FINAL"));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.versionType === "FINAL"));
      }

      // 4. Fetch summary
      const { data: summ } = await supabase
        .from("ai_summaries")
        .select("*")
        .eq("meeting_id", meetingId)
        .maybeSingle();

      setAiSummary(summ);
      if (summ) {
        setEditedExecSummary(summ.executive_summary || "");
        setEditedDecisions(summ.decisions || []);
        setEditedReprocessedExecSummary(summ.reprocessed_executive_summary || "");
        setEditedReprocessedDecisions(summ.reprocessed_decisions || []);
      }

      // 5. Fetch action items
      const { data: acts } = await supabase
        .from("action_items")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });
      
      if (acts) {
        setActionItems(acts.filter((item: any) => !item.is_reprocessed));
        setReprocessedActionItems(acts.filter((item: any) => item.is_reprocessed));
      } else {
        setActionItems([]);
        setReprocessedActionItems([]);
      }

      // 6. Fetch AI jobs + chat history (new pipeline)
      const { data: jobs } = await supabase
        .from("ai_jobs")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });
      setAiJobs(jobs || []);

      const { data: chats } = await supabase
        .from("meeting_chats")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });
      setChatMessages(chats || []);
      setConversationId(chats?.[0]?.conversation_id || crypto.randomUUID());

    } catch (err) {
      console.error(err);
      await showCustomAlert("Không thể tải thông tin cuộc họp.", "error");
      router.push("/");
    } finally {
      setLoading(false);
    }
  };

  // Silent refresh: reload data without showing loading spinner (prevents screen flash)
  const refreshMeetingDataSilently = async () => {
    try {
      const { data: m } = await supabase.from("meetings").select("*").eq("id", meetingId).single();
      if (m) setMeeting(m);

      const { data: sps } = await supabase.from("speakers").select("*").eq("meeting_id", meetingId);
      setSpeakers(sps || []);

      const { data: txs } = await supabase
        .from("transcripts")
        .select(`id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, is_reprocessed, version_type, is_active, speakers ( display_name, color_hex, speaker_tag )`)
        .eq("meeting_id", meetingId)
        .order("start_ms", { ascending: true });

      if (txs) {
        const HOT_COLORS = ["#ea580c", "#dc2626", "#d97706", "#db2777"];
        const COLD_COLORS = ["#2563eb", "#4f46e5", "#0d9488", "#0891b2"];
        const uniqueSpeakerTags = Array.from(new Set(txs.map((t: any) => t.speakers?.speaker_tag || "speaker_1")));
        const speakerToColorMap: { [tag: string]: string } = {};
        uniqueSpeakerTags.forEach((tag, idx) => {
          if (idx % 2 === 0) {
            speakerToColorMap[tag] = HOT_COLORS[Math.floor(idx / 2) % HOT_COLORS.length];
          } else {
            speakerToColorMap[tag] = COLD_COLORS[Math.floor(idx / 2) % COLD_COLORS.length];
          }
        });

        const allTranscripts = txs.map((t: any) => {
          const tag = t.speakers?.speaker_tag || "speaker_1";
          return {
            id: t.id,
            originalText: t.original_text,
            correctedText: t.corrected_text,
            translatedText: t.translated_text,
            speakerName: t.speakers?.display_name || "Unknown",
            speakerTag: tag,
            speakerColor: speakerToColorMap[tag] || t.speakers?.color_hex || "#64748b",
            startMs: t.start_ms,
            endMs: t.end_ms,
            confidence: t.confidence,
            isEdited: t.is_edited,
            editedText: t.edited_text,
            isReprocessed: t.is_reprocessed || false,
            versionType: t.version_type || "RAW"
          };
        });

        setTranscripts(allTranscripts.filter((t: any) => t.versionType !== "FINAL"));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.versionType === "FINAL"));
      }

      const { data: summ } = await supabase.from("ai_summaries").select("*").eq("meeting_id", meetingId).maybeSingle();
      setAiSummary(summ);
      if (summ) {
        setEditedExecSummary(summ.executive_summary || "");
        setEditedDecisions(summ.decisions || []);
        setEditedReprocessedExecSummary(summ.reprocessed_executive_summary || "");
        setEditedReprocessedDecisions(summ.reprocessed_decisions || []);
      }

      const { data: acts } = await supabase.from("action_items").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
      if (acts) {
        setActionItems(acts.filter((item: any) => !item.is_reprocessed));
        setReprocessedActionItems(acts.filter((item: any) => item.is_reprocessed));
      }

      // Poll AI job progress
      const { data: jobs } = await supabase.from("ai_jobs").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
      setAiJobs(jobs || []);
    } catch (err) {
      console.error("Silent refresh error:", err);
    }
  };

  const handleTogglePin = async () => {
    try {
      const newVal = !meeting.is_pinned;
      const { error } = await supabase
        .from("meetings")
        .update({ is_pinned: newVal })
        .eq("id", meetingId);
      if (error) throw error;
      setMeeting({ ...meeting, is_pinned: newVal });
    } catch (err) {
      console.error(err);
      addToast("Lỗi thao tác", "Không thể cập nhật trạng thái ghim.", "error");
    }
  };

  const handleToggleFavorite = async () => {
    try {
      const newVal = !meeting.is_favorite;
      const { error } = await supabase
        .from("meetings")
        .update({ is_favorite: newVal })
        .eq("id", meetingId);
      if (error) throw error;
      setMeeting({ ...meeting, is_favorite: newVal });
    } catch (err) {
      console.error(err);
      addToast("Lỗi thao tác", "Không thể cập nhật trạng thái yêu thích.", "error");
    }
  };

  const handleDeleteMeeting = async () => {
    const confirmed = await showCustomConfirm("Bạn có chắc chắn muốn xóa cuộc họp này cùng toàn bộ dữ liệu?");
    if (!confirmed) return;
    try {
      const { error } = await supabase.from("meetings").delete().eq("id", meetingId);
      if (error) throw error;
      sessionStorage.setItem("pending_toast", JSON.stringify({ title: "Thông báo", message: "Xóa cuộc họp thành công!", type: "success" }));
      router.push("/");
    } catch (err) {
      console.error(err);
    }
  };

  // Toggle checkbox of action items directly in UI
  const handleToggleActionItem = async (itemId: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from("action_items")
        .update({ is_completed: !currentStatus })
        .eq("id", itemId);

      if (error) throw error;

      setActionItems(
        actionItems.map((item) =>
          item.id === itemId ? { ...item, is_completed: !currentStatus } : item
        )
      );
    } catch (err) {
      console.error(err);
    }
  };

  // Speaker Rename: gọi API bulk rename + cập nhật local state
  const handleRenameSpeaker = async () => {
    if (!renamingSpeaker || !renameValue.trim()) return;
    setIsRenaming(true);
    try {
      const res = await fetch("/api/meetings/rename-speaker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          speaker_tag: renamingSpeaker.tag,
          new_name: renameValue.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to rename");

      // Cập nhật local state — tất cả transcripts cùng speaker_tag
      const newName = renameValue.trim();
      setTranscripts((prev) =>
        prev.map((t) =>
          t.speakerTag === renamingSpeaker.tag
            ? { ...t, speakerName: newName }
            : t
        )
      );
      setReprocessedTranscripts((prev) =>
        prev.map((t) =>
          t.speakerTag === renamingSpeaker.tag
            ? { ...t, speakerName: newName }
            : t
        )
      );
      // Cập nhật speakers list
      setSpeakers((prev) =>
        prev.map((s) =>
          s.speaker_tag === renamingSpeaker.tag
            ? { ...s, display_name: newName }
            : s
        )
      );

      setRenamingSpeaker(null);
      await showCustomAlert(`Đã đổi tên thành "${newName}" cho ${data.updated_count || 0} dòng.`, "success", "Thành công");
    } catch (err) {
      console.error("Rename speaker error:", err);
      await showCustomAlert(`Không thể đổi tên: ${String(err)}`, "error");
    } finally {
      setIsRenaming(false);
    }
  };

  // Manual Edit AI Summary save (Live)
  const handleSaveSummary = async () => {
    setIsSavingSummary(true);
    try {
      const { error } = await supabase
        .from("ai_summaries")
        .update({
          executive_summary: editedExecSummary,
          decisions: editedDecisions,
        })
        .eq("meeting_id", meetingId);

      if (error) throw error;

      setAiSummary((prev: any) => ({
        ...prev,
        executive_summary: editedExecSummary,
        decisions: editedDecisions,
      }));
      setIsEditingSummary(false);
    } catch (err) {
      console.error(err);
      await showCustomAlert("Lỗi khi lưu tóm tắt cuộc họp.", "error");
    } finally {
      setIsSavingSummary(false);
    }
  };

  // Manual Edit AI Summary save (Reprocessed)
  const handleSaveReprocessedSummary = async () => {
    setIsSavingSummary(true);
    try {
      const { error } = await supabase
        .from("ai_summaries")
        .update({
          reprocessed_executive_summary: editedReprocessedExecSummary,
          reprocessed_decisions: editedReprocessedDecisions,
        })
        .eq("meeting_id", meetingId);

      if (error) throw error;

      setAiSummary((prev: any) => ({
        ...prev,
        reprocessed_executive_summary: editedReprocessedExecSummary,
        reprocessed_decisions: editedReprocessedDecisions,
      }));
      setIsEditingReprocessedSummary(false);
    } catch (err) {
      console.error(err);
      await showCustomAlert("Lỗi khi lưu tóm tắt cuộc họp.", "error");
    } finally {
      setIsSavingSummary(false);
    }
  };

  const handleAddDecisionField = () => {
    setEditedDecisions([...editedDecisions, ""]);
  };

  const handleRemoveDecisionField = (index: number) => {
    setEditedDecisions(editedDecisions.filter((_, idx) => idx !== index));
  };

  const handleUpdateDecision = (index: number, val: string) => {
    setEditedDecisions(editedDecisions.map((d, idx) => (idx === index ? val : d)));
  };

  const handleAddReprocessedDecisionField = () => {
    setEditedReprocessedDecisions([...editedReprocessedDecisions, ""]);
  };

  const handleRemoveReprocessedDecisionField = (index: number) => {
    setEditedReprocessedDecisions(editedReprocessedDecisions.filter((_, idx) => idx !== index));
  };

  const handleUpdateReprocessedDecision = (index: number, val: string) => {
    setEditedReprocessedDecisions(editedReprocessedDecisions.map((d, idx) => (idx === index ? val : d)));
  };

  // Call API route /api/regenerate-summary
  const handleRegenerateSummary = async () => {
    const confirmed = await showCustomConfirm("Tải lại tóm tắt bằng Trợ lý AI? Thao tác này sẽ ghi đè lên các Action Items cũ.");
    if (!confirmed) return;
    setIsRegeneratingSummary(true);
    try {
      const res = await fetch("/api/regenerate-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regeneration failed");

      // Reload all data
      await fetchMeetingData();
      await showCustomAlert("Cập nhật tóm tắt thành công!", "success");
    } catch (err) {
      console.error(err);
      await showCustomAlert("Lỗi khi tạo lại tóm tắt cuộc họp.", "error");
    } finally {
      setIsRegeneratingSummary(false);
    }
  };

  // Call API route /api/reprocess-raw-transcript
  const handleReprocessRawTranscript = async () => {
    const rawText = meeting?.raw_transcript || transcripts.map(t => t.originalText).join(" ");
    if (!rawText.trim()) {
      await showCustomAlert("Không có văn bản gốc nào để xử lý.", "error");
      return;
    }
    
    const confirmed = await showCustomConfirm("Hệ thống sẽ chạy AI phân tích ngữ cảnh toàn bộ câu chuyện và chia lại vai người nói. Thao tác này sẽ ghi đè lên danh sách hội thoại, tóm tắt và hành động hiện tại. Bạn có chắc chắn muốn tiếp tục?");
    if (!confirmed) {
      return;
    }

    setIsReprocessingRaw(true);
    try {
      const res = await fetch("/api/reprocess-raw-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          raw_transcript: rawText,
          num_speakers: numSpeakers
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Phân tích thất bại");
      }

      // Silent reload data without loading spinner (prevents screen flash)
      await refreshMeetingDataSilently();
      
      // Show toast instead of blocking modal
      addToast("Thành công", "Đã phân tích và tách vai lại cuộc họp.", "success");
      
      setActiveTab("transcript");
    } catch (err: any) {
      console.error(err);
      addToast("Lỗi xử lý", err.message || "", "error");
    } finally {
      setIsReprocessingRaw(false);
    }
  };

  // Edit transcript line text
  const startEditingTranscript = (line: any) => {
    setEditingTranscriptId(line.id);
    setEditingTextVal(line.correctedText || line.originalText);
  };

  const handleSaveTranscriptLine = async (lineId: string) => {
    setIsSavingLine(true);
    try {
      // 1. Call translation API to re-translate the edited text
      const translationRes = await fetch("/api/translate-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: editingTextVal,
          sourceLang: meeting?.source_language,
          targetLang: meeting?.target_language,
        }),
      });

      let newTranslation = "";
      if (translationRes.ok) {
        const transData = await translationRes.json();
        newTranslation = transData.translatedText || "";
      }

      // 2. Update transcripts in Database
      const updatePayload: any = {
        is_edited: true,
        edited_text: editingTextVal,
        corrected_text: editingTextVal,
      };

      if (newTranslation) {
        updatePayload.translated_text = newTranslation;
      }

      const { error } = await supabase
        .from("transcripts")
        .update(updatePayload)
        .eq("id", lineId);

      if (error) throw error;

      // 3. Update React States
      setTranscripts(
        transcripts.map((t) =>
          t.id === lineId
            ? {
                ...t,
                isEdited: true,
                editedText: editingTextVal,
                correctedText: editingTextVal,
                translatedText: newTranslation || t.translatedText,
              }
            : t
        )
      );
      setReprocessedTranscripts(
        reprocessedTranscripts.map((t) =>
          t.id === lineId
            ? {
                ...t,
                isEdited: true,
                editedText: editingTextVal,
                correctedText: editingTextVal,
                translatedText: newTranslation || t.translatedText,
              }
            : t
        )
      );
      setEditingTranscriptId(null);
    } catch (err) {
      console.error(err);
      await showCustomAlert("Lỗi khi lưu dòng hội thoại.", "error");
    } finally {
      setIsSavingLine(false);
    }
  };

  // Download DOCX file
  const handleExportDocx = async () => {
    const speakersFormatted = speakers.map((s) => ({ display_name: s.display_name, language_code: s.language_code }));
    const transcriptsFormatted = transcripts.map((t) => ({
      speaker_name: t.speakerName,
      original_text: t.originalText,
      corrected_text: t.correctedText,
      translated_text: t.translatedText,
      start_ms: t.startMs,
    }));
    const actionItemsFormatted = actionItems.map((item) => ({
      description: item.description,
      owner: item.owner || "",
      deadline: item.deadline || "",
    }));

    await exportToDocx(meeting, speakersFormatted, transcriptsFormatted, aiSummary, actionItemsFormatted);
  };

  // Download PDF file
  const handleExportPdf = () => {
    const speakersFormatted = speakers.map((s) => ({ display_name: s.display_name, language_code: s.language_code }));
    const transcriptsFormatted = transcripts.map((t) => ({
      speaker_name: t.speakerName,
      original_text: t.originalText,
      corrected_text: t.correctedText,
      translated_text: t.translatedText,
      start_ms: t.startMs,
    }));
    const actionItemsFormatted = actionItems.map((item) => ({
      description: item.description,
      owner: item.owner || "",
      deadline: item.deadline || "",
    }));

    exportToPdf(meeting, speakersFormatted, transcriptsFormatted, aiSummary, actionItemsFormatted);
  };

  // Text Highlighting search match helper
  const highlightText = (text: string, query: string) => {
    if (!text || !query.trim()) return text;
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/đ/g, "d");
    const normText = norm(text);
    const normQuery = norm(query);
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    while (true) {
      const index = normText.indexOf(normQuery, lastIndex);
      if (index === -1) {
        parts.push(text.substring(lastIndex));
        break;
      }
      if (index > lastIndex) {
        parts.push(text.substring(lastIndex, index));
      }
      const matchEnd = index + normQuery.length;
      const matchedString = text.substring(index, matchEnd);
      parts.push(
        <mark key={index} className="bg-yellow-200 dark:bg-yellow-700/60 dark:text-white px-0.5 rounded">
          {matchedString}
        </mark>
      );
      lastIndex = matchEnd;
    }
    return parts;
  };

  // Playlist state and ref for playing all sentences sequentially
  const [playingAllType, setPlayingAllType] = useState<"original" | "translated" | null>(null);
  const playlistRef = useRef<{
    type: "original" | "translated";
    items: any[];
    index: number;
  } | null>(null);

  const stopPlayingAll = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingAllType(null);
    setActiveSpeech(null);
    playlistRef.current = null;
  }, []);

  const playPlaylistItem = useCallback((index: number) => {
    if (!playlistRef.current) return;
    const { type, items } = playlistRef.current;
    if (index >= items.length) {
      // Playlist finished
      setPlayingAllType(null);
      setActiveSpeech(null);
      playlistRef.current = null;
      return;
    }

    playlistRef.current.index = index;
    const item = items[index];
    const text = type === "original" ? (item.correctedText || item.originalText) : item.translatedText;

    if (!text) {
      // Skip empty items
      playPlaylistItem(index + 1);
      return;
    }

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);

      if (type === "original") {
        const srcLang = meeting?.source_language || "ja";
        utterance.lang = srcLang === "ja" ? "ja-JP" : srcLang === "vi" ? "vi-VN" : "en-US";
      } else {
        const voice = voices.find((v) => v.name === selectedVoice);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        } else {
          const targetLang = meeting?.target_language || "vi";
          utterance.lang = targetLang === "vi" ? "vi-VN" : targetLang === "ja" ? "ja-JP" : "en-US";
        }
      }

      utterance.onstart = () => {
        setActiveSpeech({ id: item.id });
      };

      utterance.onend = () => {
        if (playlistRef.current && playlistRef.current.index === index) {
          playPlaylistItem(index + 1);
        }
      };

      utterance.onerror = () => {
        if (playlistRef.current && playlistRef.current.index === index) {
          playPlaylistItem(index + 1);
        }
      };

      window.speechSynthesis.speak(utterance);
    }
  }, [meeting, voices, selectedVoice]);

  const startPlayingPlaylist = (type: "original" | "translated", items: any[]) => {
    if (items.length === 0) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      
      const validItems = items.filter((item) => {
        const txt = type === "original" ? (item.correctedText || item.originalText) : item.translatedText;
        return !!txt;
      });

      if (validItems.length === 0) return;

      playlistRef.current = {
        type,
        items: validItems,
        index: 0
      };
      setPlayingAllType(type);
      playPlaylistItem(0);
    }
  };

  const playTts = (id: string, text: string, isOriginal: boolean = false) => {
    if (!text) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      if (playlistRef.current) {
        setPlayingAllType(null);
        playlistRef.current = null;
      }

      if (activeSpeech && activeSpeech.id === id) {
        window.speechSynthesis.cancel();
        setActiveSpeech(null);
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      
      if (isOriginal) {
        const srcLang = meeting?.source_language || "ja";
        utterance.lang = srcLang === "ja" ? "ja-JP" : srcLang === "vi" ? "vi-VN" : "en-US";
      } else {
        const voice = voices.find((v) => v.name === selectedVoice);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        } else {
          const targetLang = meeting?.target_language || "vi";
          utterance.lang = targetLang === "vi" ? "vi-VN" : targetLang === "ja" ? "ja-JP" : "en-US";
        }
      }

      utterance.onstart = () => {
        setActiveSpeech({ id });
      };
      
      utterance.onend = () => {
        setActiveSpeech(null);
      };

      utterance.onerror = () => {
        setActiveSpeech(null);
      };
      
      window.speechSynthesis.speak(utterance);
    }
  };

  // Filter transcripts by search keyword
  const filteredTranscripts = transcripts.filter((t) => {
    if (!searchQuery.trim()) return true;
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/đ/g, "d");
    const txt = norm(t.correctedText || t.originalText);
    const trans = norm(t.translatedText || "");
    const query = norm(searchQuery);
    return txt.includes(query) || trans.includes(query);
  });

  const filteredReprocessedTranscripts = reprocessedTranscripts.filter((t) => {
    if (!searchQuery.trim()) return true;
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/đ/g, "d");
    const txt = norm(t.correctedText || t.originalText);
    const trans = norm(t.translatedText || "");
    const query = norm(searchQuery);
    return txt.includes(query) || trans.includes(query);
  });

  const formatDuration = (ms: number) => {
    if (!ms) return "0 phút";
    const mins = Math.round(ms / 60000);
    return `${mins} phút`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans select-none">
        {/* Header (Static rendering while loading) */}
        <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
          <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 h-14 sm:h-16 flex items-center justify-between gap-3">
            {/* Left: Back + Title Skeleton */}
            <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
              <button
                onClick={() => router.push("/")}
                className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
                title="Quay lại danh sách"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="w-48 sm:w-64 h-5 sm:h-6 bg-slate-200 dark:bg-slate-800 animate-pulse rounded" />
            </div>

            {/* Right: Action Buttons skeleton */}
            <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
              <div className="p-1.5 sm:p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
                <div className="w-3.5 h-3.5 sm:w-4 sm:h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
              </div>
              <div className="p-1.5 sm:p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
                <div className="w-3.5 h-3.5 sm:w-4 sm:h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
              </div>
              <div className="p-1.5 sm:p-2 border border-slate-200 dark:border-slate-800 rounded-md bg-slate-50 dark:bg-slate-900/50">
                <div className="w-3.5 h-3.5 sm:w-4 sm:h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
              </div>

              <div className="w-px h-5 sm:h-6 bg-slate-200 dark:bg-slate-800" />

              <div className="flex items-center justify-center space-x-1.5 p-1.5 sm:px-3 sm:h-8 border border-slate-200 dark:border-slate-800 rounded-md bg-slate-50 dark:bg-slate-900/50">
                <div className="w-4 h-4 sm:w-[18px] sm:h-[18px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" />
                <div className="hidden sm:block h-2.5 w-[60px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
              </div>
              <div className="flex items-center justify-center space-x-1.5 p-1.5 sm:px-3 sm:h-8 border border-slate-200 dark:border-slate-800 rounded-md bg-slate-50 dark:bg-slate-900/50">
                <div className="w-4 h-4 sm:w-[18px] sm:h-[18px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" />
                <div className="hidden sm:block h-2.5 w-[54px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
              </div>
            </div>
          </div>
        </header>
        
        {/* Core container skeleton */}
        <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-4">
          <div className="space-y-6">
            
            {/* TOP BAR skeleton */}
            <div className="flex flex-col xl:flex-row xl:items-end justify-between border-b border-slate-200 dark:border-slate-800 gap-4 pb-0">
              
              {/* Unified 3-Tab Switcher skeleton (khớp layout switcher thật) */}
              <div className="relative grid grid-cols-3 xl:flex w-full xl:w-[600px] select-none shrink-0 order-2 xl:order-1 gap-y-0">
                <div className="relative flex-1 flex items-center justify-center space-x-1.5 px-2 pt-2.5 pb-2 xl:pt-3 xl:pb-1.5 whitespace-nowrap border-r border-r-slate-200 dark:border-r-slate-800">
                  <div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" />
                  <div className="h-4 sm:h-5 w-24 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
                </div>

                <div className="relative flex-1 flex items-center justify-center space-x-1.5 px-2 pt-2.5 pb-2 xl:pt-3 xl:pb-1.5 whitespace-nowrap border-r border-r-slate-200 dark:border-r-slate-800">
                  <div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" />
                  <div className="h-4 sm:h-5 w-16 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
                </div>

                <div className="relative flex-1 flex items-center justify-center space-x-1.5 px-2 pt-2.5 pb-2 xl:pt-3 xl:pb-1.5 whitespace-nowrap">
                  <div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" />
                  <div className="h-4 sm:h-5 w-14 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
                </div>
              </div>

              {/* Skeleton Info Bar */}
              <div className="grid grid-cols-4 xl:flex w-full xl:w-auto order-1 xl:order-2 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 xl:mb-[5.5px] bg-slate-50 dark:bg-slate-900/60 shadow-sm divide-x divide-slate-200 dark:divide-slate-800">
                <div className="h-[28px] w-full xl:w-auto flex items-center justify-center xl:justify-start px-3 space-x-1.5"><div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" /><div className="h-2.5 w-[65px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" /></div>
                <div className="h-[28px] w-full xl:w-auto flex items-center justify-center xl:justify-start px-3 space-x-1.5"><div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" /><div className="h-2.5 w-[40px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" /></div>
                <div className="h-[28px] w-full xl:w-auto flex items-center justify-center xl:justify-start px-3 space-x-1.5"><div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" /><div className="h-2.5 w-[45px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" /></div>
                <div className="h-[28px] w-full xl:w-auto flex items-center justify-center xl:justify-start px-3 space-x-1.5"><div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse shrink-0" /><div className="h-2.5 w-[50px] bg-slate-200 dark:bg-slate-800 rounded animate-pulse" /></div>
              </div>
            </div>

            {/* MAIN CONTENT AREA skeleton */}
            <div className="w-full space-y-6 text-left">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                
                {/* Left/Middle Column (Summary & Decisions) */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
                        <div className="w-32 h-5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                    </div>
                    <div className="p-5 space-y-3">
                      <div className="w-full h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-full h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-[90%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-[95%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                    </div>
                  </div>
                  
                  {/* Decisions */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
                        <div className="w-40 h-5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                    </div>
                    <div className="p-5 space-y-4">
                      <div className="flex items-start space-x-3">
                        <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-slate-300 dark:bg-slate-700 animate-pulse shrink-0" />
                        <div className="w-[85%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-slate-300 dark:bg-slate-700 animate-pulse shrink-0" />
                        <div className="w-[75%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-slate-300 dark:bg-slate-700 animate-pulse shrink-0" />
                        <div className="w-[80%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column (Action Items Checklist) */}
                <div className="space-y-6">
                  {/* Action Items Skeleton */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
                        <div className="w-36 h-5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                    </div>
                    <div className="p-5 space-y-4">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex items-start space-x-3 py-1 border-b border-slate-100 dark:border-slate-800/50 last:border-0">
                          <div className="w-5 h-5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse mt-0.5 shrink-0" />
                          <div className="flex-1 space-y-2.5">
                            <div className="w-[90%] h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                            <div className="flex items-center space-x-2">
                              <div className="w-20 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                              <div className="w-24 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Pipeline processing statuses
  const processingStatuses = [
    "queued", "uploading", "transcribing",
  ];
  const isInPipeline = meeting && processingStatuses.includes(meeting.status);
  const isPipelineTerminal = meeting && ["failed", "cancelled"].includes(meeting.status) && meeting.source_type !== "live";

  // Show processing UI for pipeline meetings
  if (isInPipeline || isPipelineTerminal) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans select-none">
        {/* Header */}
        <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
          <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 h-14 sm:h-16 flex items-center justify-between gap-3">
            <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
              <button
                onClick={() => router.push("/")}
                className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
                title="Quay lại danh sách"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="font-bold text-sm sm:text-lg leading-tight truncate" title={meeting?.title}>{meeting?.title}</h1>
              {meeting?.source_type && meeting.source_type !== 'live' && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-bold uppercase">
                  {meeting.source_type}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Processing content */}
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-xl">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 shadow-sm">
              <div className="text-center mb-8">
                <div className="w-16 h-16 mx-auto bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-4">
                  <Sparkles className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">Đang xử lý âm thanh</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  AI đang phân tích và xử lý file của bạn. Bạn có thể rời trang và quay lại sau.
                </p>
              </div>
              <PipelineProgress
                meetingId={meetingId}
                initialStatus={meeting.status}
                initialProgress={meeting.progress}
                onCompleted={() => {
                  // Reload page to show full results
                  window.location.reload();
                }}
                onCancel={() => {
                  // Status will update via Realtime
                }}
                onResume={() => {
                  // Status will update via Realtime
                }}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <>
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
      {/* HEADER */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 h-14 sm:h-16 flex items-center justify-between gap-3">
          {/* Left: Back + Title */}
          <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
            <button
              onClick={() => router.push("/")}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
              title="Quay lại danh sách"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-sm sm:text-lg leading-tight truncate" title={meeting?.title}>{meeting?.title}</h1>
          </div>

          {/* Right: Action Buttons */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            <button
              onClick={handleTogglePin}
              className={`p-1.5 sm:p-2 rounded-md border cursor-pointer transition-all duration-200 ${
                meeting.is_pinned
                  ? "bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-900/50 dark:text-blue-400"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-100 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:hover:text-slate-300 dark:hover:bg-slate-800 dark:hover:border-slate-700"
              }`}
              title="Ghim"
            >
              <Pin className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${meeting.is_pinned ? "fill-current" : ""}`} />
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`p-1.5 sm:p-2 rounded-md border cursor-pointer transition-all duration-200 ${
                meeting.is_favorite
                  ? "bg-amber-50 border-amber-200 text-amber-500 dark:bg-amber-950/40 dark:border-amber-900/50 dark:text-amber-400"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-100 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:hover:text-slate-300 dark:hover:bg-slate-800 dark:hover:border-slate-700"
              }`}
              title="Yêu thích"
            >
              <Star className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${meeting.is_favorite ? "fill-current" : ""}`} />
            </button>
            <button
              onClick={handleDeleteMeeting}
              className="p-1.5 sm:p-2 border border-slate-200 text-slate-400 hover:text-red-500 hover:bg-red-50 hover:border-red-200 rounded-md bg-white dark:bg-slate-900 dark:border-slate-800 dark:hover:bg-red-950/30 dark:hover:border-red-900/50 dark:hover:text-red-400 cursor-pointer transition-all duration-200"
              title="Xóa"
            >
              <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>

            <div className="w-px h-5 sm:h-6 bg-slate-200 dark:bg-slate-800" />

            {/* Export buttons: icon-only on mobile, icon+text on sm+ */}
            <button
              onClick={handleExportDocx}
              className="flex items-center justify-center space-x-1.5 p-1.5 sm:px-3 sm:h-8 text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 border border-slate-200 dark:border-slate-800 rounded-md text-xs font-semibold transition-colors cursor-pointer"
              title="Xuất Word"
            >
              <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px] shrink-0" viewBox="0 0 24 24" fill="none">
                <path d="M4 4a2 2 0 012-2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" fill="#3B82F6"/>
                <path d="M14 2l6 6h-4a2 2 0 01-2-2V2z" fill="#93C5FD"/>
                <text x="12" y="17" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="Arial">DOC</text>
              </svg>
              <span className="hidden sm:inline">Xuất Word</span>
            </button>
            <button
              onClick={handleExportPdf}
              className="flex items-center justify-center space-x-1.5 p-1.5 sm:px-3 sm:h-8 text-slate-500 hover:text-red-600 hover:bg-red-50 dark:text-slate-400 dark:hover:text-red-400 dark:hover:bg-red-950/30 border border-slate-200 dark:border-slate-800 rounded-md text-xs font-semibold transition-colors cursor-pointer"
              title="Xuất PDF"
            >
              <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px] shrink-0" viewBox="0 0 24 24" fill="none">
                <path d="M4 4a2 2 0 012-2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" fill="#EF4444"/>
                <path d="M14 2l6 6h-4a2 2 0 01-2-2V2z" fill="#FCA5A5"/>
                <text x="12" y="17" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="Arial">PDF</text>
              </svg>
              <span className="hidden sm:inline">Xuất PDF</span>
            </button>
          </div>
        </div>
      </header>

      {/* CORE CONTAINER */}
      <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-4">
        <div className="space-y-6">

          {/* TOP BAR: Unified Switcher (Left) + Meeting Info (Right) */}
          <div className="flex flex-col xl:flex-row xl:items-end justify-between border-b border-slate-200 dark:border-slate-800 gap-4">
            
            {/* Unified 3-Tab Switcher (Underline style, responsive layout) */}
            <div className="relative grid grid-cols-3 xl:flex w-full xl:w-[600px] select-none shrink-0 order-2 xl:order-1 gap-y-0">
              {(() => {
                const activeIndex = activeTab === "transcript" ? 0
                  : activeTab === "summary" ? 1
                  : 2;

                const btnClass = (idx: number) =>
                  `relative flex-1 flex items-center justify-center space-x-1.5 px-2 pt-2.5 pb-2 xl:pt-3 xl:pb-1.5 text-xs sm:text-sm font-bold transition-colors duration-200 cursor-pointer whitespace-nowrap ${
                    idx < 2 ? "border-r border-r-slate-200 dark:border-r-slate-800" : ""
                  } ${
                    activeIndex === idx
                      ? "text-blue-600 dark:text-blue-400 bg-gradient-to-t from-blue-50/30 to-transparent dark:from-blue-950/5 shadow-[inset_0_-2px_0_0_#2563eb] dark:shadow-[inset_0_-2px_0_0_#60a5fa]"
                      : "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                  }`;

                return (
                  <>
                    <button onClick={() => setActiveTab("transcript")} className={btnClass(0)}>
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Transcript</span>
                    </button>
                    <button onClick={() => setActiveTab("summary")} className={btnClass(1)}>
                      <List className="w-3.5 h-3.5 shrink-0" />
                      <span>Tóm tắt</span>
                    </button>
                    <button onClick={() => setActiveTab("ask")} className={btnClass(2)}>
                      <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                      <span>Hỏi AI</span>
                    </button>
                  </>
                );
              })()}
            </div>

            {/* Meeting Info Bar */}
            <div className="grid grid-cols-4 xl:flex w-full xl:w-auto bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-lg text-[11px] xl:mb-[5.5px] xl:ml-auto overflow-hidden divide-x divide-slate-200 dark:divide-slate-800 shadow-sm order-1 xl:order-2 shrink-0 whitespace-nowrap">
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-blue-600 dark:text-blue-400 font-semibold bg-blue-50/20 dark:bg-blue-950/10">
                <Calendar className="w-3.5 h-3.5" />
                <span>{(() => { const d = new Date(meeting.created_at); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`; })()}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50/20 dark:bg-indigo-950/10">
                <Clock className="w-3.5 h-3.5" />
                <span>{formatDuration(meeting.duration_ms)}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-50/20 dark:bg-emerald-950/10">
                <BookOpen className="w-3.5 h-3.5" />
                <span className="capitalize">{meeting.meeting_context}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-amber-600 dark:text-amber-400 font-semibold bg-amber-50/20 dark:bg-amber-950/10">
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{meeting.source_language.toUpperCase()} ➔ {meeting.target_language.toUpperCase()}</span>
              </div>
            </div>

          </div>

          {/* MAIN CONTENT AREA */}
          <div className={`w-full space-y-6 text-left transition-opacity duration-200 ${(activeTab !== shownTab || transcriptVer !== shownVer) ? "opacity-40" : ""}`}>

        {/* Transcript version toggle: Bản gốc (RAW) ↔ Đã xử lý (FINAL/AI) */}
        {shownTab === "transcript" && (
          <div className="flex items-center gap-1 p-1 mb-4 bg-slate-100 dark:bg-slate-800/60 rounded-xl w-full sm:w-fit border border-slate-200/60 dark:border-slate-800">
            {([
              { key: "raw", label: "Bản gốc", count: filteredTranscripts.length },
              { key: "ai", label: "Đã xử lý (AI)", count: filteredReprocessedTranscripts.length },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setTranscriptVer(opt.key)}
                className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                  transcriptVer === opt.key
                    ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                {opt.key === "ai" ? <Sparkles className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                <span>{opt.label}</span>
                <span className="text-[11px] opacity-60">({opt.count})</span>
              </button>
            ))}
          </div>
        )}

        {/* AI PIPELINE CONTROL PANEL (Transcript tab, "Đã xử lý" view) */}
        {shownTab === "transcript" && shownVer === "ai" && (
          <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-5 rounded-xl shadow-sm space-y-4 mb-6">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-800 dark:text-slate-200">Pipeline AI</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Sửa chính tả → Phân vai → Dịch → Tóm tắt</p>
              </div>
            </div>

            {aiJobs.filter((j) => j.status !== "idle" && j.status !== "cancelled").length > 0 ? (
              <div className="space-y-3 border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-slate-50 dark:bg-slate-950">
                {aiJobs
                  .filter((j) => j.status !== "idle" && j.status !== "cancelled")
                  .map((job) => (
                    <div key={job.id} className="flex flex-col space-y-1">
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span className="text-slate-700 dark:text-slate-300 capitalize">{job.type}</span>
                        <span className={job.status === "completed" ? "text-green-600" : job.status === "failed" ? "text-red-600" : "text-blue-600"}>{job.status}</span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${job.progress || 0}%` }} />
                      </div>
                    </div>
                  ))}
                {aiJobs.some((j) => j.status === "processing" || j.status === "queued") && (
                  <div className="flex justify-end pt-1">
                    <button
                      onClick={async () => {
                        const activeJob = aiJobs.find((j) => j.status === "processing" || j.status === "queued");
                        if (!activeJob) return;
                        await fetch("/api/meetings/reprocess/cancel-job", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ jobId: activeJob.id }),
                        });
                        await refreshMeetingDataSilently();
                      }}
                      className="text-xs text-red-600 hover:underline px-2 py-1 cursor-pointer"
                    >
                      Huỷ tiến trình
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={async () => {
                  const res = await fetch("/api/meetings/reprocess/run-queue", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ meetingId, jobTypes: ["spellcheck", "speaker", "translation", "summary"] }),
                  });
                  if (res.ok) {
                    addToast("Đã bắt đầu", "Pipeline AI đang chạy ngầm.", "success");
                    setTimeout(refreshMeetingDataSilently, 1000);
                  } else {
                    addToast("Lỗi", "Không thể bắt đầu pipeline.", "error");
                  }
                }}
                className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 text-white font-semibold py-3 px-4 rounded-xl shadow-lg hover:from-indigo-700 hover:to-blue-700 transition-all flex items-center justify-center space-x-2 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Phân tích toàn diện (Generate All)</span>
              </button>
            )}
          </div>
        )}

        {/* MAIN TAB CONTENT CONTAINER */}
        {shownTab === "ask" ? (
          <div className="space-y-6 text-left">
            <div className="flex flex-col bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden h-[600px] xl:h-[800px]">
              <div className="bg-gradient-to-r from-blue-50/80 to-transparent dark:from-blue-950/20 px-5 py-4 border-b border-blue-100/60 dark:border-slate-800">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center">
                    <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h3 className="font-semibold text-slate-800 dark:text-slate-200">Trợ lý AI</h3>
                </div>
              </div>
              <div ref={chatScrollRef} className="flex-1 p-5 overflow-y-auto space-y-4 bg-slate-50 dark:bg-slate-950">
                {chatMessages.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-3">
                    <Sparkles className="w-10 h-10 opacity-50" />
                    <p className="text-sm">Hãy đặt câu hỏi về nội dung cuộc họp</p>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'user' ? (
                      <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap bg-blue-600 text-white shadow-md">
                        {msg.content}
                      </div>
                    ) : (
                      <div
                        className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 shadow-sm space-y-1.5 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: mdToHtml(msg.content || "") }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!chatInput.trim() || isChatStreaming) return;
                    const userMsg = chatInput.trim();
                    setChatInput("");
                    if (chatInputRef.current) chatInputRef.current.style.height = "auto";
                    setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
                    setIsChatStreaming(true);
                    try {
                      const res = await fetch("/api/meetings/ask-ai", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ meetingId, question: userMsg, conversationId }),
                      });
                      if (!res.ok || !res.body) throw new Error("Lỗi gọi API");
                      const reader = res.body.getReader();
                      const decoder = new TextDecoder();
                      let aiResponse = "";
                      setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        aiResponse += decoder.decode(value, { stream: true });
                        setChatMessages((prev) => {
                          const updated = [...prev];
                          updated[updated.length - 1] = { ...updated[updated.length - 1], content: aiResponse };
                          return updated;
                        });
                      }
                    } catch (err) {
                      console.error(err);
                      addToast("Lỗi", "Không thể lấy câu trả lời từ AI.", "error");
                    } finally {
                      setIsChatStreaming(false);
                    }
                  }}
                  className="flex gap-3 items-end"
                >
                  <textarea
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={(e) => {
                      setChatInput(e.target.value);
                      const t = e.currentTarget;
                      t.style.height = "auto";
                      t.style.height = Math.min(t.scrollHeight, 128) + "px";
                    }}
                    onKeyDown={(e) => {
                      // Desktop: Enter = gửi, Shift+Enter = xuống dòng.
                      // Mobile (touch): Enter luôn xuống dòng; chỉ nút Gửi mới gửi.
                      if (e.key === "Enter" && !e.shiftKey && !isTouchDevice) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    disabled={isChatStreaming}
                    rows={1}
                    placeholder="Hỏi AI về cuộc họp..."
                    className="flex-1 resize-none max-h-32 border border-slate-200 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  />
                  <button
                    type="submit"
                    disabled={isChatStreaming}
                    className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-6 py-3 rounded-xl text-sm font-semibold hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 shadow-md transition-all flex items-center justify-center"
                  >
                    {isChatStreaming ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Gửi"}
                  </button>
                </form>
              </div>
            </div>
          </div>
        ) : mainTab === "processed" ? (
          <div className="space-y-6 text-left">

            {/* SUB-TAB CONTENT */}
            {subTabProcessed === "summary" ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Left/Middle Column: Summary & Decisions */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-blue-50/80 to-transparent dark:from-blue-950/20 border-b border-blue-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center">
                          <BookOpen className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Tóm tắt tổng quan</h3>
                      </div>
                      {!isEditingSummary && (
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={() => handleCopyText(translatedExecSummary || aiSummary?.executive_summary || "", "exec_summary")}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                            title="Sao chép tóm tắt"
                          >
                            {copiedKey === "exec_summary" ? (
                              <Check className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => setIsEditingSummary(true)}
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-amber-950/30 rounded transition-colors cursor-pointer shrink-0"
                            title="Sửa tóm tắt"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {renderTranslateDropdown("live_summary")}
                          <button
                            onClick={handleRegenerateSummary}
                            disabled={isRegeneratingSummary}
                            className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:text-slate-400 dark:hover:text-emerald-400 dark:hover:bg-emerald-950/30 rounded transition-colors disabled:opacity-50 cursor-pointer shrink-0"
                            title="Tạo lại tóm tắt (AI)"
                          >
                            <RefreshCw className={`w-4 h-4 ${isRegeneratingSummary ? "animate-spin" : ""}`} />
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="px-5 py-4">
                    {isEditingSummary ? (
                      <textarea
                        rows={6}
                        value={editedExecSummary}
                        onChange={(e) => setEditedExecSummary(e.target.value)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    ) : (
                      <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre-line">
                        {translatingSection === "live_summary" ? (
                          <span className="flex items-center space-x-2 text-slate-400 dark:text-slate-500 text-sm italic py-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang dịch tóm tắt...</span>
                          </span>
                        ) : (
                          translatedExecSummary || aiSummary?.executive_summary || "Chưa có bản tóm tắt nào cho cuộc họp này. Bạn có thể nhấn 'Tạo lại (AI)' để tạo."
                        )}
                      </p>
                    )}
                    </div>
                  </div>

                  {/* Key Decisions */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-amber-50/80 to-transparent dark:from-amber-950/20 border-b border-amber-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center">
                          <CheckSquare className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Quyết định cốt lõi</h3>
                      </div>
                      {isEditingSummary ? (
                        <button
                          onClick={handleAddDecisionField}
                          className="flex items-center space-x-1 px-2.5 h-7 border border-blue-200 dark:border-blue-800/80 bg-blue-50/30 hover:bg-blue-50 dark:bg-blue-950/20 dark:hover:bg-blue-950/40 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-300 rounded transition-all cursor-pointer"
                        >
                          <span>+ Thêm quyết định</span>
                        </button>
                      ) : (
                        <div className="flex items-center space-x-1">
                          {((translatedDecisions.length > 0 ? translatedDecisions : aiSummary?.decisions) || []).length > 0 && (
                            <button
                              onClick={() => handleCopyText((translatedDecisions.length > 0 ? translatedDecisions : aiSummary.decisions).map((d: string) => `- ${d}`).join("\n"), "decisions")}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                              title="Sao chép quyết định"
                            >
                              {copiedKey === "decisions" ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          {((translatedDecisions.length > 0 ? translatedDecisions : aiSummary?.decisions) || []).length > 0 && renderTranslateDropdown("live_decisions")}
                        </div>
                      )}
                    </div>

                    <div className="px-5 py-4">
                    {isEditingSummary ? (
                      <div className="space-y-3">
                        {editedDecisions.map((dec, idx) => (
                          <div key={idx} className="flex items-center space-x-2">
                            <span className="text-xs text-slate-400 font-semibold">{idx + 1}.</span>
                            <input
                              type="text"
                              value={dec}
                              onChange={(e) => handleUpdateDecision(idx, e.target.value)}
                              className="flex-1 h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                              onClick={() => handleRemoveDecisionField(idx)}
                              className="p-1.5 text-slate-400 hover:text-red-500 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-2.5">
                        {translatingSection === "live_decisions" ? (
                          <li className="flex items-center space-x-2 text-slate-400 dark:text-slate-500 text-sm italic py-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang dịch quyết định...</span>
                          </li>
                        ) : (translatedDecisions.length > 0 ? translatedDecisions : (aiSummary?.decisions || [])).length > 0 ? (
                          (translatedDecisions.length > 0 ? translatedDecisions : (aiSummary?.decisions || [])).map((dec: string, idx: number) => (
                            <li key={idx} className="text-sm flex items-start space-x-2">
                              <span className="text-blue-500 mt-0.5">•</span>
                              <span className="text-slate-700 dark:text-slate-300">{dec}</span>
                            </li>
                          ))
                        ) : (
                          <li className="text-sm text-slate-400 italic">Không có quyết định cụ thể nào được ghi nhận.</li>
                        )}
                      </ul>
                    )}

                    {/* Save Edit Controls */}
                    {isEditingSummary && (
                      <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100 dark:border-slate-800/50">
                        <button
                          onClick={() => {
                            setIsEditingSummary(false);
                            setEditedExecSummary(aiSummary?.executive_summary || "");
                            setEditedDecisions(aiSummary?.decisions || []);
                          }}
                          className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md cursor-pointer"
                        >
                          Hủy bỏ
                        </button>
                        <button
                          onClick={handleSaveSummary}
                          disabled={isSavingSummary}
                          className="flex items-center space-x-1.5 px-4 h-9 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{isSavingSummary ? "Đang lưu..." : "Lưu thay đổi"}</span>
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                </div>

                {/* Right Column: Action Items Checklist */}
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-emerald-50/80 to-transparent dark:from-emerald-950/20 border-b border-emerald-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center">
                          <CheckSquare className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Phân công công việc</h3>
                      </div>
                      <div className="flex items-center space-x-1">
                      {actionItems.length > 0 && (
                        <button
                          onClick={() =>
                            handleCopyText(
                              actionItems
                                .map(
                                  (item) =>
                                    `- [${item.is_completed ? "x" : " "}] ${item.description} (Phụ trách: ${
                                      item.owner || "Chưa gán"
                                    }, Hạn: ${item.deadline ? new Date(item.deadline).toLocaleDateString("vi-VN") : "N/A"})`
                                )
                                .join("\n"),
                              "action_items"
                            )
                          }
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                          title="Sao chép tất cả công việc"
                        >
                          {copiedKey === "action_items" ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      {actionItems.length > 0 && renderTranslateDropdown("live_actions")}
                      </div>
                    </div>

                    <div className="px-5 py-4">
                    <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {actionItems.length === 0 ? (
                        <p className="text-xs text-slate-400 italic py-4">Không có công việc nào được phân công.</p>
                      ) : (
                        actionItems.map((item) => {
                          let deadlineStr = "N/A";
                          if (item.deadline) {
                            const d = new Date(item.deadline);
                            deadlineStr = isNaN(d.getTime())
                              ? item.deadline
                              : d.toLocaleDateString("vi-VN") +
                                " " +
                                d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
                          }

                          return (
                            <div
                              key={item.id}
                              className={`py-3 flex items-start space-x-3 transition-all ${
                                item.is_completed ? "opacity-60" : ""
                              }`}
                            >
                              <button
                                onClick={() => handleToggleActionItem(item.id, item.is_completed)}
                                className={`p-1 shrink-0 rounded transition-colors cursor-pointer ${
                                  item.is_completed ? "text-green-500" : "text-slate-400 hover:text-blue-500"
                                }`}
                              >
                                {item.is_completed ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                              </button>

                              <div className="flex-1 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p
                                    className={`text-sm font-semibold leading-snug text-slate-800 dark:text-slate-200 ${
                                      item.is_completed ? "line-through text-slate-400 dark:text-slate-500" : ""
                                    }`}
                                  >
                                    {translatingSection === "live_actions" ? (
                                      <span className="flex items-center space-x-1.5 text-slate-400 text-xs italic">
                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                        <span>Đang dịch...</span>
                                      </span>
                                    ) : (
                                      translatedActionItems[actionItems.indexOf(item)] || item.description
                                    )}
                                  </p>
                                  <button
                                    onClick={() => handleCopyText(item.description, `act_${item.id}`)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded cursor-pointer shrink-0 mt-0.5"
                                    title="Sao chép mô tả"
                                  >
                                    {copiedKey === `act_${item.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                                  <span>
                                    Phụ trách: <strong>{item.owner || "Chưa gán"}</strong>
                                  </span>
                                  {item.deadline && (
                                    <>
                                      <span>•</span>
                                      <span>
                                        Hạn: <strong>{deadlineStr}</strong>
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6 bg-transparent sm:bg-white border-0 sm:border border-slate-200/60 dark:bg-transparent dark:sm:bg-slate-900/40 dark:border-0 dark:sm:border-slate-800 p-0 sm:p-6 rounded-none sm:rounded-xl shadow-none sm:shadow-sm">
                {/* Internal Search & Voice selector */}
                <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div className="relative w-full sm:max-w-xs md:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Lọc từ khóa trong cuộc hội thoại..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-8 h-9 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-xl text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none shadow-sm"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-full transition-colors cursor-pointer"
                        title="Xóa lọc"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center space-x-3 text-xs w-full sm:w-auto justify-between sm:justify-start">
                    <span className="text-slate-400 font-medium shrink-0">Giọng đọc:</span>
                    <div className="relative flex-1 sm:flex-initial max-w-[240px] sm:max-w-[200px] w-full">
                      <select
                        value={selectedVoice}
                        onChange={(e) => setSelectedVoice(e.target.value)}
                        className="h-9 pl-3 pr-8 w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-xl focus:ring-1 focus:ring-blue-500 focus:outline-none appearance-none truncate cursor-pointer shadow-sm font-semibold text-slate-700 dark:text-slate-200"
                      >
                        {allAvailableVoices.length > 0 ? (
                          allAvailableVoices.map((v) => (
                            <option key={v.value} value={v.value}>
                              {v.name}
                            </option>
                          ))
                        ) : (
                          <option value="">Giọng mặc định hệ thống</option>
                        )}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
                    </div>
                  </div>
                </div>

                {/* Transcript — Mobile Cards */}
                <div className="sm:hidden space-y-2">
                  {filteredTranscripts.map((t) => {
                    const isEditing = editingTranscriptId === t.id;
                    const needsReview = typeof t.confidence === "number" && t.confidence < 0.8;
                    const fmtTime = (ms: number) => {
                      const s = Math.floor(ms / 1000);
                      const mm = Math.floor(s / 60);
                      const ss = s % 60;
                      return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
                    };
                    return (
                      <div
                        key={t.id}
                        id={`transcript-row-${t.id}`}
                        className={`border rounded-xl overflow-hidden transition-all duration-300 shadow-sm hover:shadow-md ${
                          activeAudioTranscriptId === t.id
                            ? "border-blue-400 dark:border-blue-600 bg-blue-50/80 dark:bg-blue-950/30 ring-1 ring-blue-200 dark:ring-blue-800"
                            : "border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-900"
                        }`}
                      >
                        {/* Header: time + speaker + tools */}
                        <div className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700/80">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[11px] font-mono font-medium ${
                                audioBlobUrl ? "cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" : ""
                              } text-slate-400`}
                              onClick={() => {
                                if (audioBlobUrl && (window as any).__audioPlayerSeekTo) {
                                  (window as any).__audioPlayerSeekTo(t.startMs);
                                }
                              }}
                            >
                              {fmtTime(t.startMs)}
                            </span>
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-blue-300 dark:hover:ring-blue-700 transition-all"
                              style={{ backgroundColor: `${t.speakerColor}15`, color: t.speakerColor }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingSpeaker({ tag: t.speakerTag, name: t.speakerName });
                                setRenameValue(t.speakerName);
                              }}
                            >
                              {t.speakerName}
                            </span>
                            {needsReview && <span className="text-amber-500 text-xs">⚠️</span>}
                            {t.isEdited && <span className="text-[9px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium">Đã sửa</span>}
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button onClick={() => handleSummarizeLine(t.id, t.correctedText || t.originalText, t.translatedText || "")} className={`p-1.5 rounded transition-colors cursor-pointer ${lineSummaries[t.id] ? "text-emerald-600 bg-emerald-50" : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50"}`} title="Tóm tắt AI">
                              <Sparkles className="w-3.5 h-3.5" />
                            </button>
                            {!isEditing && (
                              <button onClick={() => startEditingTranscript(t)} className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors cursor-pointer" title="Sửa">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        {/* Body */}
                        <div className="px-3 py-2.5 space-y-2">
                          {isEditing ? (
                            <div className="flex items-start space-x-2">
                              <textarea value={editingTextVal} onChange={(e) => setEditingTextVal(e.target.value)} disabled={isSavingLine} className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50" rows={3} />
                              <button onClick={() => handleSaveTranscriptLine(t.id)} disabled={isSavingLine} className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors cursor-pointer disabled:opacity-50">
                                {isSavingLine ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                              </button>
                            </div>
                          ) : (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                              }}
                              className="group/cell leading-relaxed cursor-pointer"
                            >
                              <span className={`text-[13px] text-slate-900 dark:text-slate-100 font-semibold ${needsReview ? "bg-amber-50/50 text-amber-800 px-1.5 py-[1px] rounded border border-dashed border-amber-250 inline" : ""}`}>
                                {highlightText(t.correctedText || t.originalText, searchQuery)}
                              </span>
                              <span 
                                className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                  activeTouchKey === `tx_orig_${t.id}`
                                    ? "opacity-100 delay-0"
                                    : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                }`}
                              >
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    playTts(t.id, t.correctedText || t.originalText, true);
                                  }}
                                  className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                    activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe gốc"}
                                >
                                  {activeSpeech?.id === t.id ? (
                                    <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                  ) : (
                                    <Volume2 className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`);
                                  }}
                                  className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                  title="Sao chép gốc"
                                >
                                  {copiedKey === `tx_orig_${t.id}` ? (
                                    <Check className="w-3 h-3 text-green-500" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </span>
                            </div>
                          )}
                          {t.translatedText && (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                              }}
                              className="group/cell leading-relaxed pt-1.5 border-t border-slate-100 dark:border-slate-800/50 cursor-pointer"
                            >
                              <span className="text-[13px] text-slate-500 dark:text-slate-400 italic">
                                {highlightText(t.translatedText, searchQuery)}
                              </span>
                              <span 
                                className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                  activeTouchKey === `tx_trans_${t.id}`
                                    ? "opacity-100 delay-0"
                                    : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                }`}
                              >
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    playTts(t.id, t.translatedText, false);
                                  }}
                                  className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                    activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe dịch"}
                                >
                                  {activeSpeech?.id === t.id ? (
                                    <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                  ) : (
                                    <Volume2 className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyText(t.translatedText, `tx_trans_${t.id}`);
                                  }}
                                  className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                  title="Sao chép bản dịch"
                                >
                                  {copiedKey === `tx_trans_${t.id}` ? (
                                    <Check className="w-3 h-3 text-green-500" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </span>
                            </div>
                          )}
                        </div>
                        {/* Line Summary */}
                        {lineSummaries[t.id] && (
                          <div className="px-3 py-2 bg-emerald-50/50 dark:bg-emerald-950/10 border-t border-emerald-100 dark:border-emerald-900/30 text-xs space-y-2">
                            {lineSummaries[t.id].loading ? (
                              <span className="flex items-center space-x-1.5 text-emerald-600"><RefreshCw className="w-3.5 h-3.5 animate-spin" /><span>Đang tóm tắt...</span></span>
                            ) : (
                              <>
                                <div><span className="font-bold text-[10px] uppercase text-emerald-600 tracking-wider">Tóm tắt gốc:</span><p className="mt-0.5 text-slate-700 dark:text-slate-350 leading-relaxed whitespace-pre-line">{lineSummaries[t.id].originalSummary}</p></div>
                                <div><span className="font-bold text-[10px] uppercase text-emerald-600 tracking-wider">Tóm tắt dịch:</span><p className="mt-0.5 text-slate-700 dark:text-slate-350 leading-relaxed whitespace-pre-line">{lineSummaries[t.id].translatedSummary}</p></div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {filteredTranscripts.length === 0 && (
                    <p className="py-12 text-center text-slate-400 italic text-sm">Không tìm thấy nội dung hội thoại nào khớp với từ khóa tìm kiếm.</p>
                  )}
                </div>

                {/* Transcript — Desktop Table */}
                <div className="hidden sm:block overflow-x-auto pr-1">
                  <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold text-xs uppercase tracking-wider">
                        <th className="py-3 px-4 text-left style-none w-16 whitespace-nowrap">Giây</th>
                        <th className="py-3 px-4 text-left style-none w-32 whitespace-nowrap">Người nói</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">
                          <div className="flex items-center space-x-1.5 select-none">
                            <span>Văn bản gốc</span>
                            <button
                              onClick={() => {
                                if (playingAllType === "original") {
                                  stopPlayingAll();
                                } else {
                                  startPlayingPlaylist("original", filteredTranscripts);
                                }
                              }}
                              className={`p-0.5 rounded transition-all duration-200 cursor-pointer inline-flex items-center justify-center ${
                                playingAllType === "original"
                                  ? "bg-red-50 text-red-500 border border-red-200 dark:bg-red-950/30 dark:border-red-900/30 shadow-sm animate-pulse"
                                  : "bg-slate-50 dark:bg-slate-950 border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:shadow-sm text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-800"
                              }`}
                              title={playingAllType === "original" ? "Dừng phát toàn bộ" : "Phát lại toàn bộ bản gốc từ trên xuống"}
                            >
                              {playingAllType === "original" ? (
                                <VolumeX className="w-3 h-3 text-red-500" />
                              ) : (
                                <Play className="w-3 h-3 fill-slate-450 dark:fill-slate-500" />
                              )}
                            </button>
                          </div>
                        </th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">
                          <div className="flex items-center space-x-1.5 select-none">
                            <span>Bản dịch</span>
                            <button
                              onClick={() => {
                                if (playingAllType === "translated") {
                                  stopPlayingAll();
                                } else {
                                  startPlayingPlaylist("translated", filteredTranscripts);
                                }
                              }}
                              className={`p-0.5 rounded transition-all duration-200 cursor-pointer inline-flex items-center justify-center ${
                                playingAllType === "translated"
                                  ? "bg-red-50 text-red-500 border border-red-200 dark:bg-red-950/30 dark:border-red-900/30 shadow-sm animate-pulse"
                                  : "bg-slate-50 dark:bg-slate-950 border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:shadow-sm text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-800"
                              }`}
                              title={playingAllType === "translated" ? "Dừng phát toàn bộ" : "Phát lại toàn bộ bản dịch từ trên xuống"}
                            >
                              {playingAllType === "translated" ? (
                                <VolumeX className="w-3 h-3 text-red-500" />
                              ) : (
                                <Play className="w-3 h-3 fill-slate-450 dark:fill-slate-500" />
                              )}
                            </button>
                          </div>
                        </th>
                        <th className="py-3 px-4 text-center style-none w-20 whitespace-nowrap">Công cụ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {filteredTranscripts.map((t) => {
                        const isEditing = editingTranscriptId === t.id;
                        const needsReview = typeof t.confidence === "number" && t.confidence < 0.8;
                        const formatTime = (ms: number) => {
                          const s = Math.floor(ms / 1000);
                          const m = Math.floor(s / 60);
                          const secs = s % 60;
                          return `${String(m).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
                        };

                        return (
                          <Fragment key={t.id}>
                            <tr
                              id={`transcript-row-${t.id}`}
                              className={`group transition-colors duration-200 ${
                                activeAudioTranscriptId === t.id
                                  ? "bg-blue-50/80 dark:bg-blue-950/30 ring-1 ring-inset ring-blue-200 dark:ring-blue-800"
                                  : "hover:bg-slate-50/55 dark:hover:bg-slate-900/50"
                              }`}
                            >
                            <td
                              className={`py-4 px-4 align-top font-medium whitespace-nowrap ${
                                audioBlobUrl ? "cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" : ""
                              } text-slate-400`}
                              onClick={() => {
                                if (audioBlobUrl && (window as any).__audioPlayerSeekTo) {
                                  (window as any).__audioPlayerSeekTo(t.startMs);
                                }
                              }}
                              title={audioBlobUrl ? "Click để phát từ vị trí này" : undefined}
                            >
                              {formatTime(t.startMs)}
                            </td>
                            <td className="py-4 px-4 align-top whitespace-nowrap">
                              <div className="flex items-center space-x-1.5">
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-blue-300 dark:hover:ring-blue-700 transition-all"
                                  style={{ backgroundColor: `${t.speakerColor}15`, color: t.speakerColor }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingSpeaker({ tag: t.speakerTag, name: t.speakerName });
                                    setRenameValue(t.speakerName);
                                  }}
                                  title="Click để đổi tên người nói"
                                >
                                  <span>{t.speakerName}</span>
                                </span>
                                {needsReview && (
                                  <span className="text-amber-500 font-extrabold text-xs cursor-help select-none" title="Độ tin cậy nhận diện thấp">⚠️</span>
                                )}
                              </div>
                            </td>
                            <td 
                              onClick={() => {
                                if (!isEditing) {
                                  setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                                }
                              }}
                              className={`py-4 px-4 align-top group/cell ${!isEditing ? "cursor-pointer" : ""}`}
                            >
                              {isEditing ? (
                                <div className="flex items-start space-x-2">
                                  <textarea
                                    value={editingTextVal}
                                    onChange={(e) => setEditingTextVal(e.target.value)}
                                    disabled={isSavingLine}
                                    className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
                                    rows={2}
                                  />
                                  <button
                                    onClick={() => handleSaveTranscriptLine(t.id)}
                                    disabled={isSavingLine}
                                    className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {isSavingLine ? (
                                      <RefreshCw className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Check className="w-4 h-4" />
                                    )}
                                  </button>
                                </div>
                              ) : (
                                <div className="leading-relaxed">
                                  <span className={`text-slate-900 dark:text-slate-100 font-semibold ${needsReview ? "bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 px-1.5 py-[1px] rounded border border-dashed border-amber-250 dark:border-amber-900/30 inline" : ""}`}>
                                    {highlightText(t.correctedText || t.originalText, searchQuery)}
                                  </span>
                                  {t.isEdited && (
                                    <span className="text-[10px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium ml-1 inline-block align-middle select-none">
                                      Đã sửa tay
                                    </span>
                                  )}
                                  <span 
                                    className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                      activeTouchKey === `tx_orig_${t.id}`
                                        ? "opacity-100 delay-0"
                                        : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                    }`}
                                  >
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        playTts(t.id, t.correctedText || t.originalText, true);
                                      }}
                                      className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                        activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe gốc"}
                                    >
                                      {activeSpeech?.id === t.id ? (
                                        <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                      ) : (
                                        <Volume2 className="w-3 h-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`);
                                      }}
                                      className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                      title="Sao chép gốc"
                                    >
                                      {copiedKey === `tx_orig_${t.id}` ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </span>
                                </div>
                              )}
                            </td>
                            <td 
                              onClick={() => {
                                setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                              }}
                              className="py-4 px-4 align-top text-slate-500 dark:text-slate-400 italic leading-relaxed group/cell cursor-pointer"
                            >
                              {t.translatedText && (
                                <div className="leading-relaxed">
                                  <span>
                                    {highlightText(t.translatedText, searchQuery)}
                                  </span>
                                  <span 
                                    className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                      activeTouchKey === `tx_trans_${t.id}`
                                        ? "opacity-100 delay-0"
                                        : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                    }`}
                                  >
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        playTts(t.id, t.translatedText, false);
                                      }}
                                      className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                        activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe dịch"}
                                    >
                                      {activeSpeech?.id === t.id ? (
                                        <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                      ) : (
                                        <Volume2 className="w-3 h-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyText(t.translatedText, `tx_trans_${t.id}`);
                                      }}
                                      className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                      title="Sao chép bản dịch"
                                    >
                                      {copiedKey === `tx_trans_${t.id}` ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 align-top text-center">
                              <div className="flex items-center justify-center space-x-1.5">
                                <button
                                  onClick={() => handleSummarizeLine(t.id, t.correctedText || t.originalText, t.translatedText || "")}
                                  className={`p-1 rounded transition-colors cursor-pointer ${
                                    lineSummaries[t.id]
                                      ? "text-emerald-600 bg-emerald-50 dark:text-emerald-450 dark:bg-emerald-950/30"
                                      : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:text-slate-400 dark:hover:text-emerald-400 dark:hover:bg-emerald-950/30"
                                  }`}
                                  title="Tóm tắt bằng AI"
                                >
                                  <Sparkles className="w-4 h-4" />
                                </button>
                                {!isEditing && (
                                  <button
                                    onClick={() => startEditingTranscript(t)}
                                    className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-amber-950/30 rounded transition-colors cursor-pointer"
                                    title="Chỉnh sửa văn bản"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {lineSummaries[t.id] && (
                            <tr className="bg-slate-50/50 dark:bg-slate-900/10 border-b border-slate-200/50 dark:border-slate-800/50">
                              <td className="hidden sm:table-cell" />
                              <td />
                              <td className="py-3 px-2 sm:px-4 text-xs leading-relaxed text-slate-600 dark:text-slate-400 align-top">
                                {lineSummaries[t.id].loading ? (
                                  <span className="flex items-center space-x-1.5 py-1">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                                    <span>Đang tạo tóm tắt văn bản gốc bằng AI...</span>
                                  </span>
                                ) : (
                                  <div className="space-y-1">
                                    <div className="flex items-center space-x-1.5">
                                      <span className="font-bold text-[10px] uppercase text-emerald-600 dark:text-emerald-400 tracking-wider block">Tóm tắt văn bản gốc:</span>
                                      <button
                                        onClick={() => handleCopyText(lineSummaries[t.id].originalSummary, `line_orig_sum_${t.id}`)}
                                        className="p-0.5 text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 rounded transition-colors cursor-pointer"
                                        title="Sao chép tóm tắt gốc"
                                      >
                                        {copiedKey === `line_orig_sum_${t.id}` ? (
                                          <Check className="w-3 h-3 text-green-500" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                      </button>
                                    </div>
                                    <p className="whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-350">{lineSummaries[t.id].originalSummary}</p>
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-4 text-xs leading-relaxed text-slate-600 dark:text-slate-400 align-top">
                                {lineSummaries[t.id].loading ? (
                                  <span className="flex items-center space-x-1.5 py-1">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                                    <span>Đang tạo tóm tắt bản dịch bằng AI...</span>
                                  </span>
                                ) : (
                                  <div className="space-y-1">
                                    <div className="flex items-center space-x-1.5">
                                      <span className="font-bold text-[10px] uppercase text-emerald-600 dark:text-emerald-400 tracking-wider block">Tóm tắt bản dịch:</span>
                                      <button
                                        onClick={() => handleCopyText(lineSummaries[t.id].translatedSummary, `line_trans_sum_${t.id}`)}
                                        className="p-0.5 text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 rounded transition-colors cursor-pointer"
                                        title="Sao chép tóm tắt dịch"
                                      >
                                        {copiedKey === `line_trans_sum_${t.id}` ? (
                                          <Check className="w-3 h-3 text-green-500" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                      </button>
                                    </div>
                                    <p className="whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-355">{lineSummaries[t.id].translatedSummary}</p>
                                  </div>
                                )}
                              </td>
                              <td className="hidden sm:table-cell" />
                            </tr>
                          )}
                        </Fragment>
                        );
                      })}
                      {filteredTranscripts.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-12 text-center text-slate-400 italic">
                            Không tìm thấy nội dung hội thoại nào khớp với từ khóa tìm kiếm.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6 text-left">
            {/* RAW LISTENING STREAM CONTROL PANEL */}
            <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
              {/* Header row */}
              <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-slate-50/80 to-transparent dark:from-slate-800/30">
                <div className="flex items-center space-x-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200">Hội thoại gốc</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">
                      Dữ liệu thô — AI sẽ phân tích ngữ cảnh và tách vai người nói
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 flex-wrap ml-auto">

                  <select
                    value={numSpeakers}
                    onChange={(e) => setNumSpeakers(e.target.value)}
                    className="h-7 px-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                  >
                    <option value="auto">Tự động</option>
                    <option value="1">1 người</option>
                    <option value="2">2 người</option>
                    <option value="3">3 người</option>
                    <option value="4">4 người</option>
                    <option value="5">5 người</option>
                  </select>

                  <button
                    onClick={handleReprocessRawTranscript}
                    disabled={isReprocessingRaw || (!meeting?.raw_transcript && transcripts.length === 0)}
                    className="flex items-center space-x-1.5 px-3 h-7 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${isReprocessingRaw ? "animate-spin" : ""}`} />
                    <span>{isReprocessingRaw ? "Đang xử lý..." : "AI Phân vai"}</span>
                  </button>
                </div>
              </div>



              {/* Raw text content */}
              <div className="p-5">
                {isReprocessingRaw ? (
                  <div className="py-10 text-center space-y-3">
                    <RefreshCw className="w-7 h-7 text-blue-500 animate-spin mx-auto" />
                    <div className="space-y-0.5">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        AI đang phân tích và tách vai hội thoại...
                      </p>
                      <p className="text-xs text-slate-400">
                        Khoảng 10 – 20 giây tùy độ dài văn bản.
                      </p>
                    </div>
                  </div>
                ) : meeting?.raw_transcript || transcripts.length > 0 ? (() => {
                  const rawText = meeting?.raw_transcript || transcripts.map((t: any) => t.originalText).join(" ");
                  const charCount = rawText.length;
                  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
                  return (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
                          <span>{charCount.toLocaleString()} ký tự</span>
                          <span className="w-0.5 h-0.5 rounded-full bg-slate-300" />
                          <span>{wordCount.toLocaleString()} từ/cụm</span>
                        </div>
                        <button
                          onClick={() => handleCopyText(rawText, "raw_transcript")}
                          className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 uppercase tracking-wider font-semibold transition-colors cursor-pointer"
                          title="Sao chép hội thoại gốc"
                        >
                          {copiedKey === "raw_transcript" ? (
                            <Check className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                      <div className="p-4 bg-slate-100/60 dark:bg-slate-950/50 rounded-lg max-h-[300px] overflow-y-auto custom-scrollbar shadow-[inset_0_2px_6px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)]">
                        <p className="text-[13px] leading-[1.85] text-slate-600 dark:text-slate-350 font-normal selection:bg-blue-100 dark:selection:bg-blue-900/40">
                          {rawText}
                        </p>
                      </div>
                    </div>
                  );
                })() : (
                  <div className="py-10 text-center text-slate-400 italic text-xs">
                    Không tìm thấy văn bản gốc. Cuộc họp này có thể được tạo trước khi cập nhật tính năng.
                  </div>
                )}
              </div>
            </div>

            {/* SUB-TAB CONTENT */}
            {reprocessedTranscripts.length === 0 ? (
              <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-8 rounded-xl shadow-sm text-center space-y-2">
                <Sparkles className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto" />
                <p className="text-xs text-slate-400 italic max-w-md mx-auto">
                  Chưa có dữ liệu phân tích lại. Chọn số người phát biểu và bấm <strong>"AI Phân vai"</strong> ở trên để bắt đầu.
                </p>
              </div>
            ) : subTabRaw === "summary" ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Left/Middle Column: Summary & Decisions */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-blue-50/80 to-transparent dark:from-blue-950/20 border-b border-blue-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5"><div className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center"><BookOpen className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /></div><h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Tóm tắt tổng quan</h3></div>
                      {!isEditingReprocessedSummary && (
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={() => handleCopyText(translatedReprocessedExecSummary || aiSummary?.reprocessed_executive_summary || "", "reprocessed_exec_summary")}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                            title="Sao chép tóm tắt"
                          >
                            {copiedKey === "reprocessed_exec_summary" ? (
                              <Check className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => setIsEditingReprocessedSummary(true)}
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-amber-950/30 rounded transition-colors cursor-pointer shrink-0"
                            title="Sửa tóm tắt"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          {renderTranslateDropdown("raw_summary")}
                        </div>
                      )}
                    </div>

                    <div className="px-5 py-4">
                    {isEditingReprocessedSummary ? (
                      <textarea
                        rows={6}
                        value={editedReprocessedExecSummary}
                        onChange={(e) => setEditedReprocessedExecSummary(e.target.value)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    ) : (
                      <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre-line">
                        {translatingSection === "raw_summary" ? (
                          <span className="flex items-center space-x-2 text-slate-400 dark:text-slate-500 text-sm italic py-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang dịch tóm tắt...</span>
                          </span>
                        ) : (
                          translatedReprocessedExecSummary || aiSummary?.reprocessed_executive_summary || "Chưa có bản tóm tắt nào cho cuộc họp này."
                        )}
                      </p>
                    )}
                    </div>
                  </div>

                  {/* Key Decisions */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-amber-50/80 to-transparent dark:from-amber-950/20 border-b border-amber-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5"><div className="w-7 h-7 rounded-lg bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center"><CheckSquare className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" /></div><h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Quyết định cốt lõi</h3></div>
                      {isEditingReprocessedSummary ? (
                        <button
                          onClick={handleAddReprocessedDecisionField}
                          className="flex items-center space-x-1 px-2.5 h-7 border border-blue-200 dark:border-blue-850 bg-blue-50/30 hover:bg-blue-50 dark:bg-blue-950/20 dark:hover:bg-blue-950/40 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-300 rounded transition-all cursor-pointer"
                        >
                          <span>+ Thêm quyết định</span>
                        </button>
                      ) : (
                        <div className="flex items-center space-x-1">
                          {((translatedReprocessedDecisions.length > 0 ? translatedReprocessedDecisions : aiSummary?.reprocessed_decisions) || []).length > 0 && (
                            <button
                              onClick={() => handleCopyText((translatedReprocessedDecisions.length > 0 ? translatedReprocessedDecisions : aiSummary.reprocessed_decisions).map((d: string) => `- ${d}`).join("\n"), "reprocessed_decisions")}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                              title="Sao chép quyết định"
                            >
                              {copiedKey === "reprocessed_decisions" ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          {((translatedReprocessedDecisions.length > 0 ? translatedReprocessedDecisions : aiSummary?.reprocessed_decisions) || []).length > 0 && renderTranslateDropdown("raw_decisions")}
                        </div>
                      )}
                    </div>

                    <div className="px-5 py-4">
                    {isEditingReprocessedSummary ? (
                      <div className="space-y-3">
                        {editedReprocessedDecisions.map((dec, idx) => (
                          <div key={idx} className="flex items-center space-x-2">
                            <span className="text-xs text-slate-400 font-semibold">{idx + 1}.</span>
                            <input
                              type="text"
                              value={dec}
                              onChange={(e) => handleUpdateReprocessedDecision(idx, e.target.value)}
                              className="flex-1 h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                              onClick={() => handleRemoveReprocessedDecisionField(idx)}
                              className="p-1.5 text-slate-400 hover:text-red-500 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-2.5">
                        {translatingSection === "raw_decisions" ? (
                          <li className="flex items-center space-x-2 text-slate-400 dark:text-slate-500 text-sm italic py-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang dịch quyết định...</span>
                          </li>
                        ) : (translatedReprocessedDecisions.length > 0 ? translatedReprocessedDecisions : (aiSummary?.reprocessed_decisions || [])).length > 0 ? (
                          (translatedReprocessedDecisions.length > 0 ? translatedReprocessedDecisions : (aiSummary?.reprocessed_decisions || [])).map((dec: string, idx: number) => (
                            <li key={idx} className="text-sm flex items-start space-x-2">
                              <span className="text-blue-500 mt-0.5">•</span>
                              <span className="text-slate-700 dark:text-slate-300">{dec}</span>
                            </li>
                          ))
                        ) : (
                          <li className="text-sm text-slate-400 italic">Không có quyết định cụ thể nào được ghi nhận.</li>
                        )}
                      </ul>
                    )}

                    {/* Save Edit Controls */}
                    {isEditingReprocessedSummary && (
                      <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100 dark:border-slate-800/50">
                        <button
                          onClick={() => {
                            setIsEditingReprocessedSummary(false);
                            setEditedReprocessedExecSummary(aiSummary?.reprocessed_executive_summary || "");
                            setEditedReprocessedDecisions(aiSummary?.reprocessed_decisions || []);
                          }}
                          className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md cursor-pointer"
                        >
                          Hủy bỏ
                        </button>
                        <button
                          onClick={handleSaveReprocessedSummary}
                          disabled={isSavingSummary}
                          className="flex items-center space-x-1.5 px-4 h-9 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{isSavingSummary ? "Đang lưu..." : "Lưu thay đổi"}</span>
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                </div>

                {/* Right Column: Action Items Checklist */}
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-emerald-50/80 to-transparent dark:from-emerald-950/20 border-b border-emerald-100/60 dark:border-slate-800 rounded-t-xl">
                      <div className="flex items-center space-x-2.5"><div className="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center"><CheckSquare className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /></div><h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Phân công công việc</h3></div>
                      <div className="flex items-center space-x-1">
                      {reprocessedActionItems.length > 0 && (
                        <button
                          onClick={() =>
                            handleCopyText(
                              reprocessedActionItems
                                .map(
                                  (item) =>
                                    `- [${item.is_completed ? "x" : " "}] ${item.description} (Phụ trách: ${
                                      item.owner || "Chưa gán"
                                    }, Hạn: ${item.deadline ? new Date(item.deadline).toLocaleDateString("vi-VN") : "N/A"})`
                                )
                                .join("\n"),
                              "reprocessed_action_items"
                            )
                          }
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer shrink-0"
                          title="Sao chép tất cả công việc"
                        >
                          {copiedKey === "reprocessed_action_items" ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      {reprocessedActionItems.length > 0 && renderTranslateDropdown("raw_actions")}
                      </div>
                    </div>

                    <div className="px-5 py-4">
                    <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {reprocessedActionItems.length === 0 ? (
                        <p className="text-sm text-slate-400 italic py-4">Không có công việc nào được phân công.</p>
                      ) : (
                        reprocessedActionItems.map((item) => {
                          let deadlineStr = "N/A";
                          if (item.deadline) {
                            const d = new Date(item.deadline);
                            deadlineStr = isNaN(d.getTime())
                              ? item.deadline
                              : d.toLocaleDateString("vi-VN") +
                                " " +
                                d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
                          }

                          return (
                            <div
                              key={item.id}
                              className={`py-3 flex items-start space-x-3 transition-all ${
                                item.is_completed ? "opacity-60" : ""
                              }`}
                            >
                              <button
                                onClick={() => handleToggleActionItem(item.id, item.is_completed)}
                                className={`p-1 shrink-0 rounded transition-colors cursor-pointer ${
                                  item.is_completed ? "text-green-500" : "text-slate-400 hover:text-blue-500"
                                }`}
                              >
                                {item.is_completed ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                              </button>

                              <div className="flex-1 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p
                                    className={`text-sm font-semibold leading-snug text-slate-800 dark:text-slate-200 ${
                                      item.is_completed ? "line-through text-slate-400 dark:text-slate-500" : ""
                                    }`}
                                  >
                                    {translatingSection === "raw_actions" ? (
                                      <span className="flex items-center space-x-1.5 text-slate-400 text-xs italic">
                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                        <span>Đang dịch...</span>
                                      </span>
                                    ) : (
                                      translatedReprocessedActionItems[reprocessedActionItems.indexOf(item)] || item.description
                                    )}
                                  </p>
                                  <button
                                    onClick={() => handleCopyText(item.description, `act_${item.id}`)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded cursor-pointer shrink-0 mt-0.5"
                                    title="Sao chép mô tả"
                                  >
                                    {copiedKey === `act_${item.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                                  <span>
                                    Phụ trách: <strong>{item.owner || "Chưa gán"}</strong>
                                  </span>
                                  {item.deadline && (
                                    <>
                                      <span>•</span>
                                      <span>
                                        Hạn: <strong>{deadlineStr}</strong>
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6 bg-transparent sm:bg-white border-0 sm:border border-slate-200/60 dark:bg-transparent dark:sm:bg-slate-900/40 dark:border-0 dark:sm:border-slate-800 p-0 sm:p-6 rounded-none sm:rounded-xl shadow-none sm:shadow-sm">
                {/* Internal Search & Voice selector */}
                <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div className="relative w-full sm:max-w-xs md:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Lọc từ khóa trong cuộc hội thoại..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-8 h-9 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-xl text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none shadow-sm"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-full transition-colors cursor-pointer"
                        title="Xóa lọc"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center space-x-3 text-xs w-full sm:w-auto justify-between sm:justify-start">
                    <span className="text-slate-400 font-medium shrink-0">Giọng đọc:</span>
                    <div className="relative flex-1 sm:flex-initial max-w-[240px] sm:max-w-[200px] w-full">
                      <select
                        value={selectedVoice}
                        onChange={(e) => setSelectedVoice(e.target.value)}
                        className="h-9 pl-3 pr-8 w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-xl focus:ring-1 focus:ring-blue-500 focus:outline-none appearance-none truncate cursor-pointer shadow-sm font-semibold text-slate-700 dark:text-slate-200"
                      >
                        {allAvailableVoices.length > 0 ? (
                          allAvailableVoices.map((v) => (
                            <option key={v.value} value={v.value}>
                              {v.name}
                            </option>
                          ))
                        ) : (
                          <option value="">Giọng mặc định hệ thống</option>
                        )}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
                    </div>
                  </div>
                </div>

                {/* Raw Transcript — Mobile Cards */}
                <div className="sm:hidden space-y-2">
                  {filteredReprocessedTranscripts.map((t) => {
                    const isEditing = editingTranscriptId === t.id;
                    const fmtTime = (ms: number) => {
                      const s = Math.floor(ms / 1000);
                      const mm = Math.floor(s / 60);
                      const ss = s % 60;
                      return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
                    };
                    return (
                      <div key={t.id} className="border border-slate-300 dark:border-slate-700/80 rounded-xl bg-white dark:bg-slate-900 overflow-hidden shadow-sm hover:shadow-md transition-all duration-300">
                        <div className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700/80">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-slate-400 font-mono font-medium">{fmtTime(t.startMs)}</span>
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold" style={{ backgroundColor: `${t.speakerColor}15`, color: t.speakerColor }}>{t.speakerName}</span>
                            {t.isEdited && <span className="text-[9px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium">Đã sửa</span>}
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button onClick={() => handleSummarizeLine(t.id, t.correctedText || t.originalText, t.translatedText || "")} className={`p-1.5 rounded transition-colors cursor-pointer ${lineSummaries[t.id] ? "text-emerald-600 bg-emerald-50" : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50"}`} title="Tóm tắt AI">
                              <Sparkles className="w-3.5 h-3.5" />
                            </button>
                            {!isEditing && (
                              <button onClick={() => startEditingTranscript(t)} className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors cursor-pointer" title="Sửa">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="px-3 py-2.5 space-y-2">
                          {isEditing ? (
                            <div className="flex items-start space-x-2">
                              <textarea value={editingTextVal} onChange={(e) => setEditingTextVal(e.target.value)} disabled={isSavingLine} className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50" rows={3} />
                              <button onClick={() => handleSaveTranscriptLine(t.id)} disabled={isSavingLine} className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors cursor-pointer disabled:opacity-50">
                                {isSavingLine ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                              </button>
                            </div>
                          ) : (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                              }}
                              className="group/cell leading-relaxed cursor-pointer"
                            >
                              <span className="text-[13px] text-slate-900 dark:text-slate-100 font-semibold">
                                {highlightText(t.correctedText || t.originalText, searchQuery)}
                              </span>
                              <span 
                                className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                  activeTouchKey === `tx_orig_${t.id}`
                                    ? "opacity-100 delay-0"
                                    : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                }`}
                              >
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    playTts(t.id, t.correctedText || t.originalText, true);
                                  }}
                                  className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                    activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe gốc"}
                                >
                                  {activeSpeech?.id === t.id ? (
                                    <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                  ) : (
                                    <Volume2 className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`);
                                  }}
                                  className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                  title="Sao chép gốc"
                                >
                                  {copiedKey === `tx_orig_${t.id}` ? (
                                    <Check className="w-3 h-3 text-green-500" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </span>
                            </div>
                          )}
                          {t.translatedText && (
                            <div 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                              }}
                              className="group/cell leading-relaxed pt-1.5 border-t border-slate-100 dark:border-slate-800/50 cursor-pointer"
                            >
                              <span className="text-[13px] text-slate-500 dark:text-slate-400 italic">
                                {highlightText(t.translatedText, searchQuery)}
                              </span>
                              <span 
                                className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                  activeTouchKey === `tx_trans_${t.id}`
                                    ? "opacity-100 delay-0"
                                    : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                }`}
                              >
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    playTts(t.id, t.translatedText, false);
                                  }}
                                  className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                    activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe dịch"}
                                >
                                  {activeSpeech?.id === t.id ? (
                                    <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                  ) : (
                                    <Volume2 className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyText(t.translatedText, `tx_trans_${t.id}`);
                                  }}
                                  className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                  title="Sao chép bản dịch"
                                >
                                  {copiedKey === `tx_trans_${t.id}` ? (
                                    <Check className="w-3 h-3 text-green-500" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </span>
                            </div>
                          )}
                        </div>
                        {lineSummaries[t.id] && (
                          <div className="px-3 py-2 bg-emerald-50/50 dark:bg-emerald-950/10 border-t border-emerald-100 dark:border-emerald-900/30 text-xs space-y-2">
                            {lineSummaries[t.id].loading ? (
                              <span className="flex items-center space-x-1.5 text-emerald-600"><RefreshCw className="w-3.5 h-3.5 animate-spin" /><span>Đang tóm tắt...</span></span>
                            ) : (
                              <>
                                <div><span className="font-bold text-[10px] uppercase text-emerald-600 tracking-wider">Tóm tắt gốc:</span><p className="mt-0.5 text-slate-700 dark:text-slate-350 leading-relaxed whitespace-pre-line">{lineSummaries[t.id].originalSummary}</p></div>
                                <div><span className="font-bold text-[10px] uppercase text-emerald-600 tracking-wider">Tóm tắt dịch:</span><p className="mt-0.5 text-slate-700 dark:text-slate-350 leading-relaxed whitespace-pre-line">{lineSummaries[t.id].translatedSummary}</p></div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {filteredReprocessedTranscripts.length === 0 && (
                    <p className="py-12 text-center text-slate-400 italic text-sm">Không tìm thấy nội dung hội thoại nào khớp với từ khóa tìm kiếm.</p>
                  )}
                </div>

                {/* Raw Transcript — Desktop Table */}
                <div className="hidden sm:block overflow-x-auto pr-1">
                  <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold text-xs uppercase tracking-wider">
                        <th className="py-3 px-4 text-left style-none w-16 whitespace-nowrap">Giây</th>
                        <th className="py-3 px-4 text-left style-none w-32 whitespace-nowrap">Người nói</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">
                          <div className="flex items-center space-x-1.5 select-none">
                            <span>Văn bản gốc</span>
                            <button
                              onClick={() => {
                                if (playingAllType === "original") {
                                  stopPlayingAll();
                                } else {
                                  startPlayingPlaylist("original", filteredReprocessedTranscripts);
                                }
                              }}
                              className={`p-0.5 rounded transition-all duration-200 cursor-pointer inline-flex items-center justify-center ${
                                playingAllType === "original"
                                  ? "bg-red-50 text-red-500 border border-red-200 dark:bg-red-950/30 dark:border-red-900/30 shadow-sm animate-pulse"
                                  : "bg-slate-50 dark:bg-slate-950 border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:shadow-sm text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-800"
                              }`}
                              title={playingAllType === "original" ? "Dừng phát toàn bộ" : "Phát lại toàn bộ bản gốc từ trên xuống"}
                            >
                              {playingAllType === "original" ? (
                                <VolumeX className="w-3 h-3 text-red-500" />
                              ) : (
                                <Play className="w-3 h-3 fill-slate-450 dark:fill-slate-500" />
                              )}
                            </button>
                          </div>
                        </th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">
                          <div className="flex items-center space-x-1.5 select-none">
                            <span>Bản dịch</span>
                            <button
                              onClick={() => {
                                if (playingAllType === "translated") {
                                  stopPlayingAll();
                                } else {
                                  startPlayingPlaylist("translated", filteredReprocessedTranscripts);
                                }
                              }}
                              className={`p-0.5 rounded transition-all duration-200 cursor-pointer inline-flex items-center justify-center ${
                                playingAllType === "translated"
                                  ? "bg-red-50 text-red-500 border border-red-200 dark:bg-red-950/30 dark:border-red-900/30 shadow-sm animate-pulse"
                                  : "bg-slate-50 dark:bg-slate-950 border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:shadow-sm text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-800"
                              }`}
                              title={playingAllType === "translated" ? "Dừng phát toàn bộ" : "Phát lại toàn bộ bản dịch từ trên xuống"}
                            >
                              {playingAllType === "translated" ? (
                                <VolumeX className="w-3 h-3 text-red-500" />
                              ) : (
                                <Play className="w-3 h-3 fill-slate-450 dark:fill-slate-500" />
                              )}
                            </button>
                          </div>
                        </th>
                        <th className="py-3 px-4 text-center style-none w-20 whitespace-nowrap">Công cụ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {filteredReprocessedTranscripts.map((t) => {
                        const isEditing = editingTranscriptId === t.id;
                        const formatTime = (ms: number) => {
                          const s = Math.floor(ms / 1000);
                          const m = Math.floor(s / 60);
                          const secs = s % 60;
                          return `${String(m).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
                        };

                        return (
                          <Fragment key={t.id}>
                            <tr className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50 group">
                            <td className="py-4 px-4 align-top text-slate-400 font-medium whitespace-nowrap">
                              {formatTime(t.startMs)}
                            </td>
                            <td className="py-4 px-4 align-top whitespace-nowrap">
                              <div className="flex items-center space-x-1.5">
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
                                  style={{ backgroundColor: `${t.speakerColor}15`, color: t.speakerColor }}
                                >
                                  <span>{t.speakerName}</span>
                                </span>
                              </div>
                            </td>
                            <td 
                              onClick={() => {
                                if (!isEditing) {
                                  setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                                }
                              }}
                              className={`py-4 px-4 align-top group/cell ${!isEditing ? "cursor-pointer" : ""}`}
                            >
                              {isEditing ? (
                                <div className="flex items-start space-x-2">
                                  <textarea
                                    value={editingTextVal}
                                    onChange={(e) => setEditingTextVal(e.target.value)}
                                    disabled={isSavingLine}
                                    className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
                                    rows={2}
                                  />
                                  <button
                                    onClick={() => handleSaveTranscriptLine(t.id)}
                                    disabled={isSavingLine}
                                    className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {isSavingLine ? (
                                      <RefreshCw className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Check className="w-4 h-4" />
                                    )}
                                  </button>
                                </div>
                              ) : (
                                <div className="leading-relaxed">
                                  <span className="text-slate-900 dark:text-slate-100 font-semibold">
                                    {highlightText(t.correctedText || t.originalText, searchQuery)}
                                  </span>
                                  {t.isEdited && (
                                    <span className="text-[10px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium ml-1 inline-block align-middle select-none">
                                      Đã sửa tay
                                    </span>
                                  )}
                                  <span 
                                    className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                      activeTouchKey === `tx_orig_${t.id}`
                                        ? "opacity-100 delay-0"
                                        : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                    }`}
                                  >
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        playTts(t.id, t.correctedText || t.originalText, true);
                                      }}
                                      className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                        activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe gốc"}
                                    >
                                      {activeSpeech?.id === t.id ? (
                                        <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                      ) : (
                                        <Volume2 className="w-3 h-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`);
                                      }}
                                      className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                      title="Sao chép gốc"
                                    >
                                      {copiedKey === `tx_orig_${t.id}` ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </span>
                                </div>
                              )}
                            </td>
                            <td 
                              onClick={() => {
                                setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                              }}
                              className="py-4 px-4 align-top text-slate-500 dark:text-slate-400 italic leading-relaxed group/cell cursor-pointer"
                            >
                              {t.translatedText && (
                                <div className="leading-relaxed">
                                  <span>
                                    {highlightText(t.translatedText, searchQuery)}
                                  </span>
                                  <span 
                                    className={`inline-flex items-center ml-2 space-x-1.5 align-middle select-none transition-opacity duration-200 ${
                                      activeTouchKey === `tx_trans_${t.id}`
                                        ? "opacity-100 delay-0"
                                        : "opacity-100 xl:opacity-0 xl:group-hover/cell:opacity-100 xl:group-hover/cell:delay-[150ms]"
                                    }`}
                                  >
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        playTts(t.id, t.translatedText, false);
                                      }}
                                      className={`p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 cursor-pointer transition-colors ${
                                        activeSpeech?.id === t.id ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id ? "Dừng phát" : "Nghe dịch"}
                                    >
                                      {activeSpeech?.id === t.id ? (
                                        <VolumeX className="w-3 h-3 text-red-500 animate-pulse" />
                                      ) : (
                                        <Volume2 className="w-3 h-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyText(t.translatedText, `tx_trans_${t.id}`);
                                      }}
                                      className="p-0.5 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-750 rounded shadow-sm text-slate-400 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all cursor-pointer"
                                      title="Sao chép bản dịch"
                                    >
                                      {copiedKey === `tx_trans_${t.id}` ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 align-top text-center">
                              <div className="flex items-center justify-center space-x-1.5">
                                <button
                                  onClick={() => handleSummarizeLine(t.id, t.correctedText || t.originalText, t.translatedText || "")}
                                  className={`p-1 rounded transition-colors cursor-pointer ${
                                    lineSummaries[t.id]
                                      ? "text-emerald-600 bg-emerald-50 dark:text-emerald-450 dark:bg-emerald-950/30"
                                      : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:text-slate-400 dark:hover:text-emerald-400 dark:hover:bg-emerald-950/30"
                                  }`}
                                  title="Tóm tắt bằng AI"
                                >
                                  <Sparkles className="w-4 h-4" />
                                </button>
                                {!isEditing && (
                                  <button
                                    onClick={() => startEditingTranscript(t)}
                                    className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-amber-950/30 rounded transition-colors cursor-pointer"
                                    title="Chỉnh sửa văn bản"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {lineSummaries[t.id] && (
                            <tr className="bg-slate-50/50 dark:bg-slate-900/10 border-b border-slate-200/50 dark:border-slate-800/50">
                              <td colSpan={2} />
                              <td className="py-3 px-4 text-xs leading-relaxed text-slate-600 dark:text-slate-400 align-top">
                                {lineSummaries[t.id].loading ? (
                                  <span className="flex items-center space-x-1.5 py-1">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                                    <span>Đang tạo tóm tắt văn bản gốc bằng AI...</span>
                                  </span>
                                ) : (
                                  <div className="space-y-1">
                                    <div className="flex items-center space-x-1.5">
                                      <span className="font-bold text-[10px] uppercase text-emerald-600 dark:text-emerald-400 tracking-wider block">Tóm tắt văn bản gốc:</span>
                                      <button
                                        onClick={() => handleCopyText(lineSummaries[t.id].originalSummary, `line_orig_sum_${t.id}`)}
                                        className="p-0.5 text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 rounded transition-colors cursor-pointer"
                                        title="Sao chép tóm tắt gốc"
                                      >
                                        {copiedKey === `line_orig_sum_${t.id}` ? (
                                          <Check className="w-3 h-3 text-green-500" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                      </button>
                                    </div>
                                    <p className="whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-350">{lineSummaries[t.id].originalSummary}</p>
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-4 text-xs leading-relaxed text-slate-600 dark:text-slate-400 align-top">
                                {lineSummaries[t.id].loading ? (
                                  <span className="flex items-center space-x-1.5 py-1">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                                    <span>Đang tạo tóm tắt bản dịch bằng AI...</span>
                                  </span>
                                ) : (
                                  <div className="space-y-1">
                                    <div className="flex items-center space-x-1.5">
                                      <span className="font-bold text-[10px] uppercase text-emerald-600 dark:text-emerald-400 tracking-wider block">Tóm tắt bản dịch:</span>
                                      <button
                                        onClick={() => handleCopyText(lineSummaries[t.id].translatedSummary, `line_trans_sum_${t.id}`)}
                                        className="p-0.5 text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 rounded transition-colors cursor-pointer"
                                        title="Sao chép tóm tắt dịch"
                                      >
                                        {copiedKey === `line_trans_sum_${t.id}` ? (
                                          <Check className="w-3 h-3 text-green-500" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                      </button>
                                    </div>
                                    <p className="whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-355">{lineSummaries[t.id].translatedSummary}</p>
                                  </div>
                                )}
                              </td>
                              <td className="hidden sm:table-cell" />
                            </tr>
                          )}
                        </Fragment>
                        );
                      })}
                      {filteredReprocessedTranscripts.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-12 text-center text-slate-400 italic">
                            Không tìm thấy nội dung hội thoại nào khớp với từ khóa tìm kiếm.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
          </div>
        </div>
      </main>

      {/* CUSTOM MODAL */}
      {modalConfig.isOpen && (
        <div 
          className={`fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 ${
            modalConfig.isClosing ? "animate-modal-backdrop-out" : "animate-modal-backdrop-in"
          }`}
          onClick={() => {
            if (modalConfig.onCancel) modalConfig.onCancel();
            else if (modalConfig.onConfirm) modalConfig.onConfirm();
          }}
        >
          <style>{`
            @keyframes modal-backdrop-in {
              from { opacity: 0; backdrop-filter: blur(0); }
              to { opacity: 1; backdrop-filter: blur(4px); }
            }
            @keyframes modal-backdrop-out {
              from { opacity: 1; backdrop-filter: blur(4px); }
              to { opacity: 0; backdrop-filter: blur(0); }
            }
            @keyframes modal-card-in {
              from { opacity: 0; transform: scale(0.95); }
              to { opacity: 1; transform: scale(1); }
            }
            @keyframes modal-card-out {
              from { opacity: 1; transform: scale(1); }
              to { opacity: 0; transform: scale(0.95); }
            }
            .animate-modal-backdrop-in {
              animation: modal-backdrop-in 0.2s ease-out forwards;
            }
            .animate-modal-backdrop-out {
              animation: modal-backdrop-out 0.2s ease-in forwards;
            }
            .animate-modal-card-in {
              animation: modal-card-in 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
            }
            .animate-modal-card-out {
              animation: modal-card-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
          `}</style>
          <div 
            className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl w-full max-w-md p-6 select-none text-left ${
              modalConfig.isClosing ? "animate-modal-card-out" : "animate-modal-card-in"
            }`}
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
                    className="px-4 py-2 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={modalConfig.onConfirm}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors cursor-pointer"
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

      {/* === AUDIO PLAYER (chỉ hiển khi có blob URL từ phiên upload) === */}
      {audioBlobUrl && (
        <AudioPlayer
          blobUrl={audioBlobUrl}
          transcripts={transcripts.map(t => ({ id: t.id, start_ms: t.startMs, end_ms: t.endMs }))}
          activeTranscriptId={activeAudioTranscriptId}
          onTimeUpdate={(currentTimeMs: number) => {
            // Tìm transcript đang phát
            const active = transcripts.find(
              (t) => currentTimeMs >= t.startMs && currentTimeMs <= t.endMs
            );
            const newId = active?.id || null;
            if (newId !== activeAudioTranscriptId) {
              setActiveAudioTranscriptId(newId);
              // Auto-scroll đến transcript đang phát
              if (newId) {
                const el = document.getElementById(`transcript-row-${newId}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }
            }
          }}
          onSeekToTranscript={(startMs: number) => {
            // Handled by __audioPlayerSeekTo global
          }}
        />
      )}

      {/* === SPEAKER RENAME MODAL === */}
      {renamingSpeaker && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setRenamingSpeaker(null)}
        >
          <div
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl w-full max-w-sm p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4">Đổi tên người nói</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
              Đổi tên <strong>{renamingSpeaker.name}</strong> ({renamingSpeaker.tag}) thành:
            </p>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-semibold focus:ring-2 focus:ring-blue-500 focus:outline-none mb-4"
              placeholder="Nhập tên mới..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim()) {
                  handleRenameSpeaker();
                }
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setRenamingSpeaker(null)}
                className="flex-1 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-sm font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                Hủy
              </button>
              <button
                onClick={handleRenameSpeaker}
                disabled={!renameValue.trim() || isRenaming}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {isRenaming ? "Đang lưu..." : "Xác nhận"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* TOASTS NOTIFICATIONS PANEL */}
      <style>{`
        @keyframes toast-circle-progress {
          from { stroke-dashoffset: 0; }
          to { stroke-dashoffset: 62.83; }
        }
        @keyframes toast-in {
          0% {
            opacity: 0;
            transform: translateY(-20px) scale(0.85);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes toast-out {
          0% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
          100% {
            opacity: 0;
            transform: translateY(-20px) scale(0.85);
          }
        }
        .animate-toast-in {
          animation: toast-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        .animate-toast-out {
          animation: toast-out 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
      <div className="fixed top-1 sm:top-1.5 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 max-w-xs w-full pointer-events-none">
        {toasts.map((t) => {
          const config = {
            success: {
              border: "border-none",
              bg: "bg-gradient-to-r from-emerald-500 to-teal-600 dark:from-emerald-600 dark:to-teal-700",
              title: "text-white font-extrabold",
              desc: "text-emerald-50 dark:text-emerald-100 font-semibold",
              circle: "text-white",
              btn: "text-white hover:text-emerald-100"
            },
            warning: {
              border: "border-none",
              bg: "bg-gradient-to-r from-amber-500 to-orange-500 dark:from-amber-600 dark:to-orange-600",
              title: "text-white font-extrabold",
              desc: "text-amber-50 dark:text-amber-100 font-semibold",
              circle: "text-white",
              btn: "text-white hover:text-amber-100"
            },
            error: {
              border: "border-none",
              bg: "bg-gradient-to-r from-rose-500 to-red-650 dark:from-rose-600 dark:to-red-750",
              title: "text-white font-extrabold",
              desc: "text-rose-50 dark:text-rose-100 font-semibold",
              circle: "text-white",
              btn: "text-white hover:text-rose-100"
            },
            info: {
              border: "border-none",
              bg: "bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-600 dark:to-indigo-700",
              title: "text-white font-extrabold",
              desc: "text-blue-50 dark:text-blue-100 font-semibold",
              circle: "text-white",
              btn: "text-white hover:text-blue-100"
            }
          };

          const style = config[(t.type as keyof typeof config) || "info"] || config.info;

          return (
            <div
              key={t.id}
              className={`pointer-events-auto ${style.border} ${style.bg} py-2 px-5 rounded-2xl shadow-xl flex items-center justify-between space-x-3 relative overflow-hidden ring-1 ring-white/10 transition-all duration-300 ${t.closing ? "animate-toast-out" : "animate-toast-in"}`}
            >
              <div className="flex-1 min-w-0 pr-2 relative z-10">
                <h5 className={`font-bold text-xs leading-snug ${style.title}`}>{t.title}</h5>
                <p className={`text-[11px] font-medium leading-snug mt-0.5 ${style.desc}`}>{t.desc}</p>
              </div>
              
              <div className="relative flex items-center justify-center w-7 h-7 shrink-0 z-10">
                <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 24 24">
                  <circle
                    className="text-white/20"
                    strokeWidth="2"
                    stroke="currentColor"
                    fill="transparent"
                    r="10"
                    cx="12"
                    cy="12"
                  />
                  <circle
                    className={`${style.circle}`}
                    strokeWidth="2"
                    strokeDasharray="62.83"
                    strokeDashoffset="0"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="transparent"
                    r="10"
                    cx="12"
                    cy="12"
                    style={{ animation: "toast-circle-progress 4.7s linear forwards" }}
                  />
                </svg>
                <button
                  onClick={() => removeToast(t.id)}
                  className={`${style.btn} cursor-pointer p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 relative z-10 flex items-center justify-center transition-colors`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
