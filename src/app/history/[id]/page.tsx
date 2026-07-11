"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, use, Fragment, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { exportToDocx } from "@/lib/docx-helper";
import { exportToPdf } from "@/lib/pdf-helper";
import PipelineProgress from "@/components/PipelineProgress";
import AudioPlayer from "@/components/AudioPlayer";
import { getAudioUrl, deleteAudio } from "@/lib/audio-cache";
import {
  ArrowLeft, FileText, Download, Play, RefreshCw, Edit2, Check, X,
  Search, Pin, Star, Trash2, Calendar, Clock, BookOpen, CheckSquare, Square, MessageSquare, Copy, Languages,
  Volume2, VolumeX, Moon, Sun, Plus, Sparkles, ChevronDown, List, Globe, ChevronUp,
  AlignLeft, ListChecks, PenLine, Briefcase, Maximize2, Minimize2, LayoutList, RotateCcw, Eraser, Zap, Shield,
  Users, UserCheck, GitMerge, Hash
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
  const [loading, setLoading] = useState(true);
  const [showScrollTop, setShowScrollTop] = useState(false);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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

  // UI state
  // 3 tab: transcript (có công tắc Bản gốc/Đã xử lý) | summary | ask.
  const [activeTab, setActiveTab] = useState<"transcript" | "summary" | "ask">("summary");
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
  // true = viewing Transcript tab với công tắc "Đã xử lý (AI)" (nội dung FINAL/reprocessed
  // + panel legacy); false = mọi trường hợp còn lại (Transcript+Bản gốc, hoặc tab Tóm tắt).
  const showFinalPanel = shownTab === "transcript" && shownVer === "ai";
  const subTabProcessed: "summary" | "transcript" = shownTab === "summary" ? "summary" : "transcript";
  const [activeSummaryMode, setActiveSummaryMode] = useState<string | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [activeEditingMode, setActiveEditingMode] = useState<string | null>(null);
  const [isRewritingRaw, setIsRewritingRaw] = useState(false);
  const [rawLangMode, setRawLangMode] = useState<"original" | "translated">("original");

  // Simple markdown renderer for summary text (handles ## headings, **bold**, bullet lists)
  const renderMarkdownText = (text: string) => {
    if (!text) return null;
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    lines.forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('## ')) {
        elements.push(<h3 key={i} className="font-bold text-base text-slate-800 dark:text-slate-200 mt-4 mb-1.5 first:mt-0">{trimmed.slice(3)}</h3>);
      } else if (trimmed.startsWith('### ')) {
        elements.push(<h4 key={i} className="font-semibold text-sm text-slate-700 dark:text-slate-300 mt-3 mb-1 first:mt-0">{trimmed.slice(4)}</h4>);
      } else if (trimmed.startsWith('# ')) {
        elements.push(<h2 key={i} className="font-bold text-lg text-slate-800 dark:text-slate-200 mt-4 mb-2 first:mt-0">{trimmed.slice(2)}</h2>);
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        elements.push(<li key={i} className="text-sm text-slate-700 dark:text-slate-300 ml-4 list-disc leading-relaxed">{trimmed.slice(2)}</li>);
      } else if (trimmed === '') {
        elements.push(<div key={i} className="h-2" />);
      } else {
        elements.push(<p key={i} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{line}</p>);
      }
    });
    return <>{elements}</>;
  };

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
  const [showReprocessMenu, setShowReprocessMenu] = useState(false);
  const [reprocessTab, setReprocessTab] = useState<"spellcheck" | "speaker" | "translate" | "editing">("spellcheck");
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const reprocessMenuRef = useRef<HTMLDivElement>(null);
  // Tự động cuộn xuống cuối khi có tin nhắn mới, AI đang stream, hoặc khi mở tab Hỏi AI
  useEffect(() => {
    if (shownTab !== "ask") return;
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, shownTab]);
  // Close reprocess dropdown on outside click
  useEffect(() => {
    if (!showReprocessMenu) return;
    const handler = (e: MouseEvent) => {
      if (reprocessMenuRef.current && !reprocessMenuRef.current.contains(e.target as Node)) {
        setShowReprocessMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showReprocessMenu]);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [activeSpeech, setActiveSpeech] = useState<{ id: string; type: "original" | "translated" } | null>(null);

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


  // Editing state for AI Summary (Live)
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedExecSummary, setEditedExecSummary] = useState("");
  const [editedDecisions, setEditedDecisions] = useState<string[]>([]);


  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);

  // Selective AI-processing checklist (Transcript tab, "Bản gốc" view) — lets the user
  // pick which of spellcheck/speaker/translation to run, instead of the old
  // all-or-nothing "Phân tích toàn diện" trigger.
  const [fixSpellcheck, setFixSpellcheck] = useState(true);
  const [fixSpeaker, setFixSpeaker] = useState(true);
  const [fixTranslate, setFixTranslate] = useState(true);
  const [processTargetLang, setProcessTargetLangState] = useState("vi");
  const processTargetLangInitRef = useRef(false);

  // Editing state for transcripts lines
  const [editingTranscriptId, setEditingTranscriptId] = useState<string | null>(null);
  const [editingTextVal, setEditingTextVal] = useState("");

  // Refs for tracking initial values to detect changes for auto-save
  const initialEditingTextRef = useRef("");
  const initialExecSummaryRef = useRef("");
  const initialDecisionsRef = useRef<string[]>([]);

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

  // Keyboard Shortcuts (Space to play/pause, ArrowUp/ArrowDown to switch lines)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in input, textarea, or contentEditable elements
      const target = e.target as HTMLElement;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault(); // Prevent page scrolling
        if (typeof (window as any).__audioPlayerTogglePlay === "function") {
          (window as any).__audioPlayerTogglePlay();
        }
      } else if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        e.preventDefault();
        
        // Find visible transcripts depending on current tab/filter
        const activeList = transcriptVer === "ai" ? reprocessedTranscripts : transcripts;
        if (activeList.length === 0) return;

        let targetIndex = 0;
        if (activeAudioTranscriptId) {
          const currentIndex = activeList.findIndex(t => t.id === activeAudioTranscriptId);
          if (currentIndex !== -1) {
            if (e.code === "ArrowUp") {
              targetIndex = Math.max(0, currentIndex - 1);
            } else {
              targetIndex = Math.min(activeList.length - 1, currentIndex + 1);
            }
          }
        } else {
          // If no active line, ArrowDown starts at 0, ArrowUp starts at last
          targetIndex = e.code === "ArrowDown" ? 0 : activeList.length - 1;
        }

        const targetLine = activeList[targetIndex];
        if (targetLine) {
          if (typeof (window as any).__audioPlayerSeekTo === "function") {
            (window as any).__audioPlayerSeekTo(targetLine.startMs);
          }
          setActiveAudioTranscriptId(targetLine.id);
          const el = document.getElementById(`transcript-row-${targetLine.id}`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [activeAudioTranscriptId, transcripts, reprocessedTranscripts, activeTab, transcriptVer]);

  // Translation states for Summary & Decisions
  const [translatedExecSummary, setTranslatedExecSummary] = useState<string>("");
  const [translatedDecisions, setTranslatedDecisions] = useState<string[]>([]);
  const [translatedActionItems, setTranslatedActionItems] = useState<string[]>([]);
  const [isTranslatingSummary, setIsTranslatingSummary] = useState(false);
  const [isTranslatingDecisions, setIsTranslatingDecisions] = useState(false);
  const [isTranslatingActionItems, setIsTranslatingActionItems] = useState(false);
  const [globalLanguage, setGlobalLanguage] = useState<string>("original");
  const [activeGlobalTranslateDropdown, setActiveGlobalTranslateDropdown] = useState(false);

  const getReprocessToastMessage = (actionDesc: string) => {
    const langNames: Record<string, string> = {
      vi: "tiếng Việt",
      en: "tiếng Anh",
      ja: "tiếng Nhật",
    };
    if (globalLanguage && globalLanguage !== "original" && langNames[globalLanguage]) {
      return `${actionDesc} và dịch sang ${langNames[globalLanguage]}...`;
    }
    return `${actionDesc}...`;
  };

  const translateAllSections = async (
    lang: string,
    overrideData?: { summary?: string; decisions?: string[]; action_items?: string[] },
    isFromReprocess?: boolean
  ) => {
    const langNames: Record<string, string> = {
      vi: "tiếng Việt",
      en: "tiếng Anh",
      ja: "tiếng Nhật",
      original: "Bản gốc",
    };

    if (lang === "original") {
      setTranslatedExecSummary("");
      setTranslatedDecisions([]);
      setTranslatedActionItems([]);
      addToast("Khôi phục", "Đã chuyển về ngôn ngữ gốc.", "success");
      return;
    }

    if (!isFromReprocess) {
      addToast("Đang dịch", `Đang dịch nội dung sang ${langNames[lang] || lang}...`, "success");
    }
    setIsTranslatingSummary(true);
    setIsTranslatingDecisions(true);
    setIsTranslatingActionItems(true);

    try {
      const summaryText = overrideData?.summary !== undefined 
        ? overrideData.summary 
        : (aiSummary?.executive_summary || "");

      const decisionsArray = overrideData?.decisions !== undefined
        ? overrideData.decisions
        : (aiSummary?.decisions || []);

      const actionItemsArray = overrideData?.action_items !== undefined
        ? overrideData.action_items
        : actionItems.map((item: any) => item.description);

      const res = await fetch("/api/translate-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sections: {
            summary: summaryText,
            decisions: decisionsArray,
            action_items: actionItemsArray,
          },
          sourceLang: "auto",
          targetLang: lang,
        }),
      });

      if (!res.ok) {
        throw new Error("Không thể dịch nội dung");
      }

      const data = await res.json();
      const translatedSections = data.translatedSections || {};

      setTranslatedExecSummary(translatedSections.summary || "");
      setTranslatedDecisions(translatedSections.decisions || []);
      setTranslatedActionItems(translatedSections.action_items || []);
      if (isFromReprocess) {
        addToast("Thành công", `Đã hoàn thành tạo mới và dịch sang ${langNames[lang] || lang}!`, "success");
      } else {
        addToast("Thành công", `Đã dịch nội dung sang ${langNames[lang] || lang}!`, "success");
      }
    } catch (err) {
      console.error(err);
      addToast("Lỗi dịch thuật", "Không thể dịch các thẻ nội dung. Vui lòng thử lại sau.", "error");
    } finally {
      setIsTranslatingSummary(false);
      setIsTranslatingDecisions(false);
      setIsTranslatingActionItems(false);
    }
  };

  const findClosestRawLine = useCallback((reprocessedLine: any) => {
    if (!transcripts || transcripts.length === 0) return null;
    let closest = transcripts[0];
    let minDiff = Math.abs(transcripts[0].startMs - reprocessedLine.startMs);
    for (const line of transcripts) {
      const diff = Math.abs(line.startMs - reprocessedLine.startMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = line;
      }
    }
    return closest;
  }, [transcripts]);

  // Nhấp vào một dòng hội thoại: highlight dòng đó và tua audio tới đúng thời điểm ghi âm.
  // Việc phát (nếu có audio) sẽ khiến onTimeUpdate tự cuộn tới dòng đang phát.
  const handleSeekToLine = useCallback(
    (line: { id: string; startMs: number }) => {
      setActiveAudioTranscriptId(line.id);
      if (audioBlobUrl && typeof (window as any).__audioPlayerSeekTo === "function") {
        (window as any).__audioPlayerSeekTo(line.startMs);
      } else {
        // Không có audio cache -> vẫn cuộn tới dòng được chọn cho rõ ràng.
        const el = document.getElementById(`transcript-row-${line.id}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [audioBlobUrl]
  );

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

  const renderGlobalTranslateDropdown = () => {
    const isAnyTranslating = isTranslatingSummary || isTranslatingDecisions || isTranslatingActionItems;
    const langNames: Record<string, string> = {
      vi: "Tiếng Việt",
      en: "English",
      ja: "日本語",
      original: "Bản gốc",
    };

    return (
      <div className="relative">
        <button
          onClick={() => setActiveGlobalTranslateDropdown(!activeGlobalTranslateDropdown)}
          disabled={isAnyTranslating}
          className="flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-indigo-50 hover:text-indigo-650 hover:border-indigo-200 dark:hover:bg-indigo-950/20 dark:hover:text-indigo-400 dark:hover:border-indigo-805 transition-all cursor-pointer disabled:opacity-50 shadow-sm"
        >
          <Languages className={`w-3.5 h-3.5 ${isAnyTranslating ? "animate-pulse text-indigo-600 dark:text-indigo-400" : "text-slate-400 dark:text-slate-500"}`} />
          <span>Ngôn ngữ: {langNames[globalLanguage]}</span>
          <ChevronDown className="w-3 h-3 text-slate-400 dark:text-slate-500" />
        </button>

        {activeGlobalTranslateDropdown && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setActiveGlobalTranslateDropdown(false)} />
            <div className="absolute left-0 right-0 mt-2 min-w-[160px] bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-30 text-xs text-left overflow-hidden ring-1 ring-black/5">
              <div className="px-3.5 py-2 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider bg-slate-50/50 dark:bg-slate-900/20 border-b border-slate-100 dark:border-slate-800">
                Chọn ngôn ngữ hiển thị
              </div>
              {(["vi", "en", "ja"] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => {
                    setActiveGlobalTranslateDropdown(false);
                    setGlobalLanguage(lang);
                    translateAllSections(lang);
                  }}
                  className={`w-full flex items-center justify-between px-3.5 py-2 hover:bg-indigo-50/70 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 font-medium cursor-pointer transition-colors ${
                    globalLanguage === lang
                      ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50/30 dark:bg-slate-850/50"
                      : "text-slate-650 dark:text-slate-350"
                  }`}
                >
                  <span>{langNames[lang]}</span>
                  {globalLanguage === lang && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                </button>
              ))}
              <button
                onClick={() => {
                  setActiveGlobalTranslateDropdown(false);
                  setGlobalLanguage("original");
                  translateAllSections("original");
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2 hover:bg-rose-50/60 hover:text-rose-600 dark:hover:bg-rose-950/20 dark:hover:text-rose-455 font-medium cursor-pointer transition-colors border-t border-slate-100 dark:border-slate-800 ${
                  globalLanguage === "original"
                    ? "text-rose-600 dark:text-rose-450 bg-rose-50/20 dark:bg-rose-955/10"
                    : "text-slate-400"
                }`}
              >
                <span>{langNames["original"]}</span>
                {globalLanguage === "original" && <Check className="w-3.5 h-3.5 text-rose-500 dark:text-rose-450" />}
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

    // Nạp audio đã cache (ghi âm/upload) từ IndexedDB. Cache sống qua reload và chỉ
    // bị xóa khi đóng trình duyệt. getAudioUrl tạo một object URL mới từ Blob đã lưu;
    // ta revoke nó khi unmount để tránh rò rỉ bộ nhớ.
    let objectUrl: string | null = null;
    let cancelled = false;
    getAudioUrl(meetingId)
      .then((url) => {
        if (!url) return;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setAudioBlobUrl(url);
      })
      .catch((err) => {
        console.warn("Không thể nạp audio đã cache:", err);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
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
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, version_type, is_active,
          speakers ( display_name, color_hex, speaker_tag )
        `)
        .eq("meeting_id", meetingId)
        .or("is_active.eq.true,version_type.eq.RAW")
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
            versionType: t.version_type || "RAW",
            // Legacy rows predating this column have is_active === null — treat as active.
            isActive: t.is_active !== false,
          };
        });

        // Bản gốc = RAW. Hội thoại = active FINAL (hoặc active RAW nếu chưa có FINAL).
        setTranscripts(allTranscripts.filter((t: any) => t.versionType === "RAW" || t.versionType === "raw"));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.versionType === "FINAL" && t.isActive));
      }

      // 4. Fetch summary
      // is_active=true is required: executeSummaryJob (queueWorker.ts) deactivates the
      // old row and INSERTS a new versioned one instead of updating in place, so a meeting
      // that has ever run the "summary" job has >1 row per meeting_id — .maybeSingle()
      // without this filter throws "multiple rows" and silently blanks the summary.
      const { data: summ } = await supabase
        .from("ai_summaries")
        .select("*")
        .eq("meeting_id", meetingId)
        .eq("is_active", true)
        .maybeSingle();

      setAiSummary(summ);
      if (summ) {
        setEditedExecSummary(summ.executive_summary || "");
        setEditedDecisions(summ.decisions || []);
      }

      // 5. Fetch action items
      // Same versioning pattern as ai_summaries — executeSummaryJob deactivates old
      // action_items rows and inserts a new versioned batch, so old rows must be excluded.
      const { data: acts } = await supabase
        .from("action_items")
        .select("*")
        .eq("meeting_id", meetingId)
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      
      if (acts) {
        setActionItems(acts);
      } else {
        setActionItems([]);
      }

      // 6. Fetch AI jobs + chat history (new pipeline)
      const { data: jobs } = await supabase
        .from("ai_jobs")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });
      setAiJobs(jobs || []);
      if (jobs) {
        const summaryJob = jobs.find((j: any) => j.type === "summary");
        if (summaryJob) {
          if (summaryJob.status === "completed") {
            setActiveSummaryMode(summaryJob.mode);
            if (summaryJob.mode) {
              localStorage.setItem(`meeting_summary_mode_${meetingId}`, summaryJob.mode);
            }
          } else {
            const cachedMode = localStorage.getItem(`meeting_summary_mode_${meetingId}`);
            setActiveSummaryMode(cachedMode || null);
          }
        }
      }

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
      // replace: this /history/[id] URL just failed to load — leaving it in history
      // means pressing back re-triggers the same failed fetch.
      router.replace("/");
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
        .select(`id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, version_type, is_active, speakers ( display_name, color_hex, speaker_tag )`)
        .eq("meeting_id", meetingId)
        .or("is_active.eq.true,version_type.eq.RAW")
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
            versionType: t.version_type || "RAW",
            isActive: t.is_active !== false,
          };
        });

        setTranscripts(allTranscripts.filter((t: any) => t.versionType === "RAW" || t.versionType === "raw"));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.versionType === "FINAL" && t.isActive));
      }

      const { data: summ } = await supabase.from("ai_summaries").select("*").eq("meeting_id", meetingId).eq("is_active", true).maybeSingle();
      setAiSummary(summ);
      if (summ) {
        setEditedExecSummary(summ.executive_summary || "");
        setEditedDecisions(summ.decisions || []);
      }

      const { data: acts } = await supabase.from("action_items").select("*").eq("meeting_id", meetingId).eq("is_active", true).order("created_at", { ascending: true });
      if (acts) {
        setActionItems(acts);
      }

      // Poll AI job progress
      const { data: jobs } = await supabase.from("ai_jobs").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
      setAiJobs(jobs || []);
      if (jobs) {
        const summaryJob = jobs.find((j: any) => j.type === "summary");
        if (summaryJob) {
          if (summaryJob.status === "completed") {
            setActiveSummaryMode(summaryJob.mode);
            if (summaryJob.mode) {
              localStorage.setItem(`meeting_summary_mode_${meetingId}`, summaryJob.mode);
            }
          } else if (!isGeneratingSummary) {
            const cachedMode = localStorage.getItem(`meeting_summary_mode_${meetingId}`);
            setActiveSummaryMode(cachedMode || null);
          }
        }
      }
    } catch (err) {
      console.error("Silent refresh error:", err);
    }
  };

  // Auto-poll every 1.5s while any AI job is still queued/processing
  const hasActiveJobs = aiJobs.some((j) => j.status === "queued" || j.status === "processing");
  useEffect(() => {
    if (!hasActiveJobs) {
      if (isGeneratingSummary) {
        setIsGeneratingSummary(false);
      }
      return;
    }
    const interval = setInterval(refreshMeetingDataSilently, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveJobs, isGeneratingSummary]);

  const prevHasActiveJobsRef = useRef(false);
  useEffect(() => {
    if (prevHasActiveJobsRef.current && !hasActiveJobs) {
      const completedJobs = aiJobs.filter((j) => j.status === "completed");
      const failedJobs = aiJobs.filter((j) => j.status === "failed");
      const cancelledJobs = aiJobs.filter((j) => j.status === "cancelled");

      if (failedJobs.length > 0) {
        addToast("Lỗi", "Một số bước xử lý AI của cuộc họp đã thất bại.", "error");
      } else if (cancelledJobs.length > 0) {
        addToast("Đã dừng", "Tiến trình xử lý AI cuộc họp đã bị dừng.", "warning");
      } else if (completedJobs.length > 0) {
        // Auto translate to currently selected custom global language if it's set
        if (globalLanguage && globalLanguage !== "original") {
          translateAllSections(globalLanguage, undefined, true);
        } else {
          addToast("Thành công", "Đã hoàn thành toàn bộ tiến trình xử lý AI cuộc họp!", "success");
        }
      }
    }
    prevHasActiveJobsRef.current = hasActiveJobs;
  }, [hasActiveJobs, aiJobs, globalLanguage]);

  // Default the translate-target dropdown to the meeting's current target_language once
  // loaded (only once — don't fight the user's own dropdown choice after that).
  useEffect(() => {
    if (processTargetLangInitRef.current) return;
    if (meeting?.target_language) {
      processTargetLangInitRef.current = true;
      setProcessTargetLangState(meeting.target_language);
    }
  }, [meeting?.target_language]);

  const handleRunSelectedJobs = async () => {
    const jobTypes: string[] = [];
    if (fixSpellcheck) jobTypes.push("spellcheck");
    if (fixSpeaker) jobTypes.push("speaker");
    if (fixTranslate) jobTypes.push("translation");

    if (jobTypes.length === 0) {
      addToast("Chưa chọn gì", "Hãy tick ít nhất một lựa chọn xử lý.", "error");
      return;
    }

    try {
      if (fixTranslate) {
        await supabase.from("meetings").update({ target_language: processTargetLang }).eq("id", meetingId);
      }
      const res = await fetch("/api/meetings/reprocess/run-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId, jobTypes }),
      });
      if (res.ok) {
        addToast("Đã bắt đầu", "AI đang xử lý theo lựa chọn của bạn.", "success");
        refreshMeetingDataSilently();
      } else {
        addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
      }
    } catch (err) {
      console.error("Run selected AI jobs error:", err);
      addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
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
      deleteAudio(meetingId);
      sessionStorage.setItem("pending_toast", JSON.stringify({ title: "Thông báo", message: "Xóa cuộc họp thành công!", type: "success" }));
      // replace: the meeting record is gone from the DB — leaving /history/[id] in
      // history means pressing back tries to fetch a meeting that no longer exists.
      router.replace("/");
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

  // Edit AI Summary save (Live)
  const handleSaveSummary = async (execSummary?: string, decisionsList?: string[], keepEditingOpen = false) => {
    const finalExec = execSummary !== undefined ? execSummary : editedExecSummary;
    const finalDec = decisionsList !== undefined ? decisionsList : editedDecisions;
    setIsSavingSummary(true);
    try {
      const { error } = await supabase
        .from("ai_summaries")
        .update({
          executive_summary: finalExec,
          decisions: finalDec,
        })
        .eq("meeting_id", meetingId)
        .eq("is_active", true);

      if (error) throw error;

      setAiSummary((prev: any) => ({
        ...prev,
        executive_summary: finalExec,
        decisions: finalDec,
      }));

      initialExecSummaryRef.current = finalExec;
      initialDecisionsRef.current = [...finalDec];

      if (!keepEditingOpen) {
        setIsEditingSummary(false);
      }
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

      // Auto translate to currently selected custom languages if they were set
      if (globalLanguage && globalLanguage !== "original") {
        const actionDescriptions = data.action_items
          ? data.action_items.map((item: any) => item.description)
          : [];
        translateAllSections(globalLanguage, {
          summary: data.summary,
          decisions: data.decisions,
          action_items: actionDescriptions,
        });
      } else {
        setTranslatedExecSummary("");
        setTranslatedDecisions([]);
        setTranslatedActionItems([]);
      }
    } catch (err) {
      console.error(err);
      await showCustomAlert("Lỗi khi tạo lại tóm tắt cuộc họp.", "error");
    } finally {
      setIsRegeneratingSummary(false);
    }
  };


  // Edit transcript line text
  const startEditingTranscript = (line: any) => {
    setEditingTranscriptId(line.id);
    const initialText = line.correctedText || line.originalText;
    setEditingTextVal(initialText);
    initialEditingTextRef.current = initialText;
  };

  // Auto-save for transcript lines (debounce 1.5s)
  useEffect(() => {
    if (!editingTranscriptId) return;
    if (editingTextVal === initialEditingTextRef.current) return;

    const delayDebounceFn = setTimeout(() => {
      handleSaveTranscriptLine(editingTranscriptId, editingTextVal, true);
    }, 1500);

    return () => clearTimeout(delayDebounceFn);
  }, [editingTextVal, editingTranscriptId]);

  // Auto-save for raw summary (debounce 1.5s)
  useEffect(() => {
    if (!isEditingSummary) return;

    const execChanged = editedExecSummary !== initialExecSummaryRef.current;
    const decisionsChanged = JSON.stringify(editedDecisions) !== JSON.stringify(initialDecisionsRef.current);
    if (!execChanged && !decisionsChanged) return;

    const delayDebounceFn = setTimeout(() => {
      handleSaveSummary(editedExecSummary, editedDecisions, true);
    }, 1500);

    return () => clearTimeout(delayDebounceFn);
  }, [editedExecSummary, editedDecisions, isEditingSummary]);


  const handleSaveTranscriptLine = async (lineId: string, textToSave?: string, keepEditingOpen = false) => {
    const finalVal = textToSave !== undefined ? textToSave : editingTextVal;
    if (!finalVal.trim()) return;
    setIsSavingLine(true);
    try {
      // 1. Call translation API to re-translate the edited text
      const translationRes = await fetch("/api/translate-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: finalVal,
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
        edited_text: finalVal,
        corrected_text: finalVal,
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
      setTranscripts((prevTranscripts) =>
        prevTranscripts.map((t) =>
          t.id === lineId
            ? {
                ...t,
                isEdited: true,
                editedText: finalVal,
                correctedText: finalVal,
                translatedText: newTranslation || t.translatedText,
              }
            : t
        )
      );
      setReprocessedTranscripts((prevReprocessed) =>
        prevReprocessed.map((t) =>
          t.id === lineId
            ? {
                ...t,
                isEdited: true,
                editedText: finalVal,
                correctedText: finalVal,
                translatedText: newTranslation || t.translatedText,
              }
            : t
        )
      );

      initialEditingTextRef.current = finalVal;

      if (!keepEditingOpen) {
        setEditingTranscriptId(null);
      }
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
        setActiveSpeech({ id: item.id, type });
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
    const type = isOriginal ? "original" : "translated";
    if (!text) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      if (playlistRef.current) {
        setPlayingAllType(null);
        playlistRef.current = null;
      }

      if (activeSpeech && activeSpeech.id === id && activeSpeech.type === type) {
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
        setActiveSpeech({ id, type });
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

  // Phím tắt: Space = phát/dừng đọc toàn bộ, Esc = dừng. Bỏ qua khi đang gõ trong ô nhập.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (playingAllType) {
          stopPlayingAll();
        } else {
          const items = activeTab === "transcript" && transcriptVer === "ai"
            ? filteredReprocessedTranscripts
            : filteredTranscripts;
          startPlayingPlaylist("original", items);
        }
      } else if (e.key === "Escape" && playingAllType) {
        stopPlayingAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingAllType, activeTab, transcriptVer, filteredTranscripts, filteredReprocessedTranscripts, stopPlayingAll]);

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

          {/* TOP BAR: Unified Switcher (Left) + Meeting Info (Right) */}
          <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 flex flex-col xl:flex-row xl:items-end justify-between border-t border-slate-100 dark:border-slate-800/50 gap-4">
            
            {/* Unified 4-Tab Switcher (Underline style, responsive layout) */}
            <div className="relative grid grid-cols-4 xl:flex w-full xl:w-[760px] select-none shrink-0 order-2 xl:order-1 gap-y-0">
              {(() => {
                const activeIndex = activeTab === "summary" ? 0
                  : (activeTab === "transcript" && transcriptVer === "ai") ? 1
                  : activeTab === "ask" ? 2
                  : 3;

                const btnClass = (idx: number) =>
                  `relative flex-1 flex items-center justify-center space-x-1.5 px-2 pt-3.5 pb-3 xl:pt-4 xl:pb-2.5 text-xs sm:text-sm font-bold transition-colors duration-200 cursor-pointer whitespace-nowrap ${
                    idx < 3 ? "border-r border-r-slate-200 dark:border-r-slate-800" : ""
                  } ${
                    activeIndex === idx
                      ? "text-blue-600 dark:text-blue-400 bg-gradient-to-t from-blue-50/30 to-transparent dark:from-blue-950/5 shadow-[inset_0_-2px_0_0_#2563eb] dark:shadow-[inset_0_-2px_0_0_#60a5fa]"
                      : "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                  }`;

                return (
                  <>
                    <button onClick={() => setActiveTab("summary")} className={btnClass(0)}>
                      <List className="w-3.5 h-3.5 shrink-0" />
                      <span>Tóm tắt</span>
                    </button>
                    <button onClick={() => { setActiveTab("transcript"); setTranscriptVer("ai"); }} className={btnClass(1)}>
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span>Hội thoại</span>
                      <span className="text-[11px] opacity-60">({filteredReprocessedTranscripts.length})</span>
                    </button>
                    <button onClick={() => setActiveTab("ask")} className={btnClass(2)}>
                      <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                      <span>Hỏi AI</span>
                    </button>
                    <button onClick={() => { setActiveTab("transcript"); setTranscriptVer("raw"); }} className={btnClass(3)}>
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Bản gốc</span>
                    </button>
                  </>
                );
              })()}
            </div>

            {/* Meeting Info Bar */}
            <div className="grid grid-cols-4 xl:flex w-full xl:w-auto text-[11px] xl:mb-[5.5px] xl:ml-auto overflow-hidden divide-x divide-slate-100 dark:divide-slate-800/50 shrink-0 whitespace-nowrap order-1 xl:order-2">
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-blue-600 dark:text-blue-400 font-semibold bg-blue-50/70 dark:bg-blue-950/30">
                <Calendar className="w-3.5 h-3.5" />
                <span>{(() => { const d = new Date(meeting.created_at); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`; })()}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50/70 dark:bg-indigo-950/30">
                <Clock className="w-3.5 h-3.5" />
                <span>{formatDuration(meeting.duration_ms)}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-50/70 dark:bg-emerald-950/30">
                <BookOpen className="w-3.5 h-3.5" />
                <span className="capitalize">{meeting.meeting_context}</span>
              </div>
              <div className="flex items-center justify-center xl:justify-start space-x-1.5 px-3 py-1.5 text-amber-600 dark:text-amber-400 font-semibold bg-amber-50/70 dark:bg-amber-950/30">
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{meeting.source_language.toUpperCase()} ➔ {meeting.target_language.toUpperCase()}</span>
              </div>
            </div>

          </div>
      </header>
 
      {/* CORE CONTAINER */}
      <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-4 pb-24">
        <div className="space-y-6">
 
          {/* MAIN CONTENT AREA */}
          <div className={`w-full space-y-6 text-left transition-opacity duration-200 ${(activeTab !== shownTab || transcriptVer !== shownVer) ? "opacity-40" : ""}`}>

        {/* AI PIPELINE CONTROL PANEL — hiện ở cả 2 view (Bản gốc / Đã xử lý) của tab Transcript.
            "Bản gốc": checklist cho chọn từng bước. "Đã xử lý (AI)": nút chạy toàn bộ như cũ. */}
        {shownTab === "transcript" && shownVer === "ai" && (
          <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-4 sm:p-5 rounded-xl shadow-sm space-y-4 mb-6">
            {/* Header chỉ hiện khi có job đang chạy hoặc ở view "Đã xử lý" — ở view Bản gốc,
                tiêu đề nằm gọn cùng hàng với checklist bên dưới. */}
            {(aiJobs.filter((j) => j.status !== "idle" && j.status !== "cancelled").length > 0 || (shownVer as string) !== "raw") && (
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-800 dark:text-slate-200">Xử lý AI</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Sửa chính tả → Phân vai → Dịch → Tóm tắt</p>
                  </div>
                </div>
                {/* Right side: Cancel button when processing, or Reprocess dropdown when idle */}
                {aiJobs.some((j) => j.status === "processing" || j.status === "queued") ? (
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
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50 rounded-lg transition-colors cursor-pointer border border-red-200 dark:border-red-800/50"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Huỷ tiến trình</span>
                  </button>
                ) : (shownVer as string) !== "raw" && (
                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowReprocessMenu((v) => !v); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/60 rounded-lg transition-colors cursor-pointer border border-indigo-200 dark:border-indigo-800/50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Tùy chỉnh AI</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showReprocessMenu ? "rotate-180" : ""}`} />
                    </button>
                    {showReprocessMenu && (
                      <div ref={reprocessMenuRef} className="absolute right-0 top-full mt-1.5 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                        {/* Top: Xử lý lại toàn bộ */}
                        <button
                          onClick={async () => {
                            setShowReprocessMenu(false);
                            addToast("Đã bắt đầu", getReprocessToastMessage("Đang xử lý lại toàn bộ pipeline"), "success");
                            const res = await fetch("/api/meetings/reprocess/run-queue", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ meetingId, jobTypes: ["spellcheck", "speaker", "translation", "summary"], isFromReprocess: true }),
                            });
                            if (res.ok) {
                              refreshMeetingDataSilently();
                            } else {
                              addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
                            }
                          }}
                          className="w-full text-left px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors flex items-center gap-3 cursor-pointer border-b border-slate-100 dark:border-slate-800"
                        >
                          <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center shrink-0">
                            <RefreshCw className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Xử lý lại toàn bộ</div>
                            <div className="text-xs text-slate-400 dark:text-slate-500">Chạy lại tất cả 4 bước pipeline</div>
                          </div>
                        </button>

                        {/* Tabs: Chính tả → Phân vai → Dịch thuật */}
                        <div className="flex border-b border-slate-100 dark:border-slate-800 px-1 pt-1">
                          {([
                            { key: "spellcheck" as const, label: "Chính tả", icon: Edit2 },
                            { key: "speaker" as const, label: "Phân vai", icon: Users },
                            { key: "translate" as const, label: "Dịch", icon: Languages },
                          ]).map((tab) => (
                            <button
                              key={tab.key}
                              onClick={() => setReprocessTab(tab.key)}
                              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors cursor-pointer rounded-t-lg ${
                                reprocessTab === tab.key
                                  ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/20 border-b-2 border-indigo-500"
                                  : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                              }`}
                            >
                              <tab.icon className="w-3.5 h-3.5" />
                              <span>{tab.label}</span>
                            </button>
                          ))}
                        </div>

                        {/* Tab content */}
                        <div className="py-1 max-h-64 overflow-y-auto">
                          {reprocessTab === "spellcheck" && ([
                            { label: "Mặc định", icon: RotateCcw, jobs: ["spellcheck", "speaker", "translation", "summary"], mode: null, desc: "Prompt xử lý sau khi kết thúc họp" },
                            { label: "Bỏ từ lặp & filler", icon: Eraser, jobs: ["spellcheck", "speaker", "translation", "summary"], mode: "remove_fillers", desc: "Bỏ uh, um, えー, từ lặp" },
                            { label: "Làm sạch toàn bộ", icon: Sparkles, jobs: ["spellcheck", "speaker", "translation", "summary"], mode: "deep_clean", desc: "Sửa lỗi + bỏ filler + cải thiện" },
                            { label: "Giữ nguyên tối đa", icon: Shield, jobs: ["spellcheck", "speaker", "translation", "summary"], mode: "minimal", desc: "Chỉ sửa lỗi rõ ràng nhất" },
                            { label: "Sửa mạnh (khôi phục)", icon: Zap, jobs: ["spellcheck", "speaker", "translation", "summary"], mode: "aggressive", desc: "Khôi phục từ gốc từ lỗi ASR" },
                          ] as const).map((opt) => (
                            <button
                              key={opt.label}
                              onClick={async () => {
                                setShowReprocessMenu(false);
                                addToast("Đã bắt đầu", getReprocessToastMessage(`Đang ${opt.label.toLowerCase()}`), "success");
                                const res = await fetch("/api/meetings/reprocess/run-queue", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ meetingId, jobTypes: opt.jobs, mode: opt.mode, isFromReprocess: true }),
                                });
                                if (res.ok) {
                                  refreshMeetingDataSilently();
                                } else {
                                  addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
                                }
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-center gap-3 cursor-pointer"
                            >
                              <opt.icon className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{opt.label}</div>
                                <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{opt.desc}</div>
                              </div>
                            </button>
                          ))}

                          {reprocessTab === "speaker" && ([
                            { label: "Mặc định", icon: RotateCcw, jobs: ["speaker", "translation", "summary"], mode: null, desc: "Prompt xử lý sau khi kết thúc họp" },
                            { label: "Độc thoại (Tách câu)", icon: FileText, jobs: ["speaker", "translation", "summary"], mode: "single_speaker_split", desc: "Giữ các câu ngắn tách biệt (phù hợp video 1 người)" },
                            { label: "Gán tên từ nội dung", icon: UserCheck, jobs: ["speaker", "translation", "summary"], mode: "by_name", desc: "Tìm tên thật từ ngữ cảnh hội thoại" },
                            { label: "Theo vai trò", icon: Briefcase, jobs: ["speaker", "translation", "summary"], mode: "by_role", desc: "Quản lý, Nhân viên, Khách hàng..." },
                            { label: "Gộp người nói", icon: GitMerge, jobs: ["speaker", "translation", "summary"], mode: "merge_speakers", desc: "Gộp speaker bị ASR tách nhầm" },
                            { label: "Đánh số đơn giản", icon: Hash, jobs: ["speaker", "translation", "summary"], mode: "numbered", desc: "Speaker 1, Speaker 2..." },
                          ] as const).map((opt) => (
                            <button
                              key={opt.label}
                              onClick={async () => {
                                setShowReprocessMenu(false);
                                addToast("Đã bắt đầu", getReprocessToastMessage(`Đang ${opt.label.toLowerCase()}`), "success");
                                const res = await fetch("/api/meetings/reprocess/run-queue", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ meetingId, jobTypes: opt.jobs, mode: opt.mode, isFromReprocess: true }),
                                });
                                if (res.ok) {
                                  refreshMeetingDataSilently();
                                } else {
                                  addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
                                }
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-center gap-3 cursor-pointer"
                            >
                              <opt.icon className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{opt.label}</div>
                                <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{opt.desc}</div>
                              </div>
                            </button>
                          ))}

                          {reprocessTab === "translate" && ([
                            { label: "Mặc định", icon: RotateCcw, jobs: ["translation", "summary"], mode: null, desc: "Prompt xử lý sau khi kết thúc họp" },
                            { label: "Dịch và chỉnh sửa", icon: Sparkles, jobs: ["translation", "summary"], mode: "translate_clean", desc: "Sửa ngữ pháp, rõ ràng hơn" },
                            { label: "Dịch đơn giản", icon: Globe, jobs: ["translation", "summary"], mode: "translate_simplify", desc: "Dễ đọc và dễ hiểu hơn" },
                          ] as const).map((opt) => (
                            <button
                              key={opt.label}
                              onClick={async () => {
                                setShowReprocessMenu(false);
                                addToast("Đã bắt đầu", getReprocessToastMessage(`Đang ${opt.label.toLowerCase()}`), "success");
                                const res = await fetch("/api/meetings/reprocess/run-queue", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ meetingId, jobTypes: opt.jobs, mode: opt.mode, isFromReprocess: true }),
                                });
                                if (res.ok) {
                                  refreshMeetingDataSilently();
                                } else {
                                  addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
                                }
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-center gap-3 cursor-pointer"
                            >
                              <opt.icon className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{opt.label}</div>
                                <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{opt.desc}</div>
                              </div>
                            </button>
                          ))}


                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {aiJobs.length > 0 ? (
              <div className="space-y-3 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-5 bg-slate-50 dark:bg-slate-950">
                {/* Horizontal stepper: numbered circles + connector lines. The circle of the
                    step currently processing gets a spinning ring border. */}
                <div className="flex items-center">
                  {(() => {
                    const STEP_ORDER = ["spellcheck", "speaker", "translation", "summary"];
                    const STEP_LABEL: Record<string, string> = {
                      spellcheck: "Sửa chính tả",
                      speaker: "Phân vai",
                      translation: "Dịch",
                      summary: "Tóm tắt",
                    };
                    
                    const activeOrFailed = aiJobs.find(
                      (j) => j.status === "processing" || (j.status === "queued" && (j.retry_count || 0) > 0) || j.status === "failed"
                    );

                    return (
                      <div className="space-y-4 w-full">
                        <div className="flex items-center">
                          {STEP_ORDER.map((stepType, idx) => {
                            const job = aiJobs.find((j) => j.type === stepType);
                            const isDone = job?.status === "completed";
                            const isRetrying = job?.status === "queued" && (job.retry_count || 0) > 0;
                            const isProcessing = job?.status === "processing";
                            const isFailed = job?.status === "failed";
                            const isCancelled = job?.status === "cancelled";
                            
                            return (
                              <Fragment key={stepType}>
                                <div className="flex items-center gap-2 shrink-0">
                                  <div className="relative w-8 h-8 shrink-0">
                                    {isProcessing && (
                                      <div className="absolute -inset-1 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                                    )}
                                    {isRetrying && (
                                      <div className="absolute -inset-1 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
                                    )}
                                    <div
                                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                                        isDone
                                          ? "bg-blue-600 text-white"
                                          : isProcessing
                                          ? "bg-blue-600 text-white"
                                          : isRetrying
                                          ? "bg-amber-500 text-white animate-pulse"
                                          : isFailed
                                          ? "bg-red-500 text-white"
                                          : isCancelled
                                          ? "bg-slate-100 dark:bg-slate-850 text-slate-400 dark:text-slate-500 border border-dashed border-slate-300 dark:border-slate-700"
                                          : "bg-slate-200 dark:bg-slate-800 text-slate-550 dark:text-slate-400"
                                      }`}
                                    >
                                      {isDone ? <Check className="w-4 h-4 stroke-[3]" /> : idx + 1}
                                    </div>
                                  </div>
                                  <span
                                    className={`text-xs sm:text-sm font-semibold whitespace-nowrap ${
                                      isDone || isProcessing
                                        ? "text-slate-800 dark:text-slate-200"
                                        : isRetrying
                                        ? "text-amber-600 dark:text-amber-400 font-bold"
                                        : isFailed
                                        ? "text-red-600 dark:text-red-400"
                                        : isCancelled
                                        ? "text-slate-400 dark:text-slate-500 italic"
                                        : "text-slate-450 dark:text-slate-500"
                                    }`}
                                  >
                                    {STEP_LABEL[stepType]}
                                  </span>
                                </div>
                                {idx < STEP_ORDER.length - 1 && (
                                  <div
                                    className={`flex-1 h-px mx-3 min-w-6 ${
                                      isDone ? "bg-blue-400 dark:bg-blue-700" : "bg-slate-200 dark:bg-slate-800"
                                    }`}
                                  />
                                )}
                              </Fragment>
                            );
                          })}
                        </div>

                        {activeOrFailed && (
                          <div className={`p-3 rounded-lg text-xs border ${
                            activeOrFailed.status === "failed"
                              ? "bg-red-50/50 dark:bg-red-950/10 border-red-200 dark:border-red-900/30 text-red-700 dark:text-red-400"
                              : (activeOrFailed.status === "queued" && (activeOrFailed.retry_count || 0) > 0)
                              ? "bg-amber-50/50 dark:bg-amber-950/10 border-amber-200 dark:border-amber-900/30 text-amber-700 dark:text-amber-400 animate-pulse"
                              : "bg-blue-50/50 dark:bg-blue-950/10 border-blue-200 dark:border-blue-900/30 text-blue-700 dark:text-blue-400"
                          }`}>
                            <p className="leading-relaxed">
                              <span className="font-bold mr-1.5 shrink-0 inline-flex items-center gap-1">
                                {activeOrFailed.status === "failed" && "❌ Lỗi:"}
                                {activeOrFailed.status === "queued" && "⚠️ Thử lại:"}
                                {activeOrFailed.status === "processing" && "⚡ Đang xử lý:"}
                              </span>
                              {(() => {
                                const getFriendlyErrorMessage = (errorStr: string) => {
                                  if (!errorStr) return "Gặp sự cố không xác định khi gọi AI.";
                                  const lower = errorStr.toLowerCase();
                                  if (lower.includes("429") || lower.includes("quota exceeded") || lower.includes("too many requests")) {
                                    return "Hệ thống AI đang quá tải hoặc vượt quá giới hạn lượt gọi (Rate Limit / Quota Exceeded). Hệ thống đang tạm dừng giãn cách và sẽ tự động gửi lại yêu cầu sau ít giây.";
                                  }
                                  if (lower.includes("api key") || lower.includes("key not found") || lower.includes("invalid api key")) {
                                    return "Khóa API của Gemini không hợp lệ hoặc chưa cấu hình đúng. Vui lòng kiểm tra cấu hình dự án.";
                                  }
                                  if (lower.includes("offline") || lower.includes("network") || lower.includes("fetch failed") || lower.includes("econnrefused")) {
                                    return "Lỗi kết nối mạng: Không thể kết nối tới máy chủ Google Gemini. Đang tự động kết nối lại...";
                                  }
                                  if (lower.includes("timeout")) {
                                    return "Kết nối tới Google Gemini bị hết hạn (Timeout). Đang tự động gửi lại yêu cầu...";
                                  }
                                  if (lower.includes("blocked") || lower.includes("safety")) {
                                    return "Nội dung bị chặn bởi bộ lọc an toàn của Google Gemini.";
                                  }
                                  return errorStr.replace(/^Error:\s*/i, "").replace(/^\[GoogleGenerativeAI Error\]:\s*/i, "").split('\n')[0];
                                };

                                if (activeOrFailed.status === "failed") {
                                  return (
                                    <>
                                      Bước <strong>{STEP_LABEL[activeOrFailed.type]}</strong> thất bại. {getFriendlyErrorMessage(activeOrFailed.error)}
                                    </>
                                  );
                                }
                                if (activeOrFailed.status === "queued") {
                                  return (
                                    <>
                                      Đang thử lại bước <strong>{STEP_LABEL[activeOrFailed.type]}</strong> (lần {activeOrFailed.retry_count}/{activeOrFailed.max_retries || 3}) sau ít giây... Chi tiết: {getFriendlyErrorMessage(activeOrFailed.error)}
                                    </>
                                  );
                                }
                                return (
                                  <>
                                    Đang xử lý bước <strong>{STEP_LABEL[activeOrFailed.type]}</strong>... Tiến trình có thể mất từ 1-2 phút tùy độ dài cuộc họp.
                                  </>
                                );
                              })()}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

              </div>
            ) : (shownVer as string) === "raw" ? ( 
              <div className="space-y-3">
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={fixSpellcheck}
                      onChange={(e) => setFixSpellcheck(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                    <span>Sửa lỗi chính tả</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={fixSpeaker}
                      onChange={(e) => setFixSpeaker(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                    <span>Phân vai qua ngữ cảnh</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={fixTranslate}
                      onChange={(e) => setFixTranslate(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                    <span>Dịch sang</span>
                  </label>
                  <select
                    value={processTargetLang}
                    onChange={(e) => setProcessTargetLangState(e.target.value)}
                    disabled={!fixTranslate}
                    className="h-7 px-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed -mt-1"
                  >
                    <option value="en">Tiếng Anh</option>
                    <option value="vi">Tiếng Việt</option>
                    <option value="ja">Tiếng Nhật</option>
                  </select>
                </div>
                <button
                  onClick={handleRunSelectedJobs}
                  className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 text-white font-semibold py-3 px-4 rounded-xl shadow-lg hover:from-indigo-700 hover:to-blue-700 transition-all flex items-center justify-center space-x-2 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>Xử lý</span>
                </button>
              </div>
            ) : null}
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
        ) : !showFinalPanel ? (
          <div className="space-y-6 text-left">

            {/* SUB-TAB CONTENT */}
            {subTabProcessed === "summary" ? (
              <div className="space-y-5">
                {/* Summary mode quick actions */}
                <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm px-4 py-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Sparkles className="w-4 h-4 text-indigo-500" />
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Tạo lại tóm tắt</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-2">
                      {([
                        { label: "Mặc định", icon: RotateCcw, mode: null as string | null, desc: "Prompt sau khi kết thúc họp" },
                        { label: "Chi tiết", icon: AlignLeft, mode: "detailed" as string | null, desc: "Phân tích đầy đủ" },
                        { label: "Bullet", icon: List, mode: "bullets" as string | null, desc: "Gạch đầu dòng" },
                        { label: "Biên bản", icon: BookOpen, mode: "meeting_minutes" as string | null, desc: "Biên bản họp" },
                        { label: "Công việc", icon: ListChecks, mode: "action_items_only" as string | null, desc: "Task & cam kết" },
                      ]).map((opt) => (
                        <button
                          key={opt.label}
                          onClick={async () => {
                            setIsGeneratingSummary(true);
                            setActiveSummaryMode(opt.mode);
                            const res = await fetch("/api/meetings/reprocess/run-queue", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ meetingId, jobTypes: ["summary"], mode: opt.mode }),
                            });
                            if (res.ok) {
                              refreshMeetingDataSilently();
                            } else {
                              setIsGeneratingSummary(false);
                              addToast("Lỗi", "Không thể bắt đầu xử lý.", "error");
                            }
                          }}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer border ${
                            activeSummaryMode === opt.mode
                              ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-800/50 ring-1 ring-indigo-200 dark:ring-indigo-800/50"
                              : "text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-400 dark:hover:border-indigo-800/50"
                          }`}
                          title={opt.desc}
                        >
                          <opt.icon className="w-3.5 h-3.5" />
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>

                    {/* Global Translation Dropdown */}
                    {renderGlobalTranslateDropdown()}
                  </div>

                  {(hasActiveJobs || isGeneratingSummary) && (
                    <div className="mt-3 p-3 rounded-lg text-xs border bg-blue-50/50 dark:bg-blue-950/10 border-blue-200 dark:border-blue-900/30 text-blue-700 dark:text-blue-400 flex items-center gap-2.5 shadow-sm">
                      <RefreshCw className="w-4 h-4 animate-spin shrink-0 text-indigo-500" />
                      <p className="leading-relaxed">
                        <span className="font-bold mr-1.5 shrink-0 inline-flex items-center gap-1">
                          Đang xử lý:
                        </span>
                        Đang tạo lại tóm tắt cuộc họp bằng AI. Tiến trình này có thể mất ít giây, vòng xoay sẽ kết thúc sau khi cập nhật dữ liệu...
                      </p>
                    </div>
                  )}
                </div>

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
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
                          <span>Tóm tắt tổng quan</span>
                          {isTranslatingSummary && (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                          )}
                        </h3>
                      </div>
                      {isEditingSummary ? (
                        <button
                          onClick={() => {
                            setIsEditingSummary(false);
                            if (editedExecSummary.trim() !== (aiSummary?.executive_summary || "") || JSON.stringify(editedDecisions) !== JSON.stringify(aiSummary?.decisions || [])) {
                              handleSaveSummary(editedExecSummary, editedDecisions, false);
                            }
                          }}
                          className="flex items-center space-x-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer shrink-0"
                          title="Hoàn thành chỉnh sửa"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Xong</span>
                        </button>
                      ) : (
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
                            onClick={() => {
                              setIsEditingSummary(true);
                              initialExecSummaryRef.current = editedExecSummary;
                              initialDecisionsRef.current = [...editedDecisions];
                            }}
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:text-slate-400 dark:hover:text-amber-400 dark:hover:bg-amber-950/30 rounded transition-colors cursor-pointer shrink-0"
                            title="Sửa tóm tắt"
                          >
                            <Edit2 className="w-4 h-4" />
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
                      renderMarkdownText(translatedExecSummary || aiSummary?.executive_summary || "Chưa có bản tóm tắt nào cho cuộc họp này. Bạn có thể nhấn 'Tạo lại (AI)' để tạo.")
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
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
                          <span>Quyết định cốt lõi</span>
                          {isTranslatingDecisions && (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" />
                          )}
                        </h3>
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
                        {(translatedDecisions.length > 0 ? translatedDecisions : (aiSummary?.decisions || [])).length > 0 ? (
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
                        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
                          <span>Phân công công việc</span>
                          {isTranslatingActionItems && (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                          )}
                        </h3>
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
                                    {translatedActionItems[actionItems.indexOf(item)] || item.description}
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
              </div>
            ) : (
              <div className="space-y-5">
                {/* Editing mode quick actions */}
                <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-xl shadow-sm px-4 py-3">
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-indigo-500" />
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Sửa bản ghi gốc (AI)</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { label: "Bản gốc", icon: RotateCcw, mode: null as string | null, desc: "Bản ghi gốc thuần từ Deepgram" },
                      { label: "Viết lại rõ ràng", icon: PenLine, mode: "rephrase" as string | null, desc: "Diễn đạt lại cho mạch lạc" },
                      { label: "Thêm cấu trúc", icon: LayoutList, mode: "add_structure" as string | null, desc: "Tổ chức đoạn văn & dấu câu" },
                      { label: "Chuyên nghiệp", icon: Briefcase, mode: "professional" as string | null, desc: "Giọng điệu trang trọng" },
                      { label: "Mở rộng", icon: Maximize2, mode: "make_longer" as string | null, desc: "Thêm chi tiết vào nội dung" },
                      { label: "Rút gọn", icon: Minimize2, mode: "make_shorter" as string | null, desc: "Thu gọn nội dung ngắn hơn" },
                    ]).map((opt) => (
                      <button
                        key={opt.label}
                        disabled={isRewritingRaw}
                        onClick={async () => {
                          setIsRewritingRaw(true);
                          setActiveEditingMode(opt.mode);
                          try {
                            const res = await fetch("/api/meetings/reprocess/raw-rewrite", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ meetingId, mode: opt.mode }),
                            });
                            if (res.ok) {
                              await refreshMeetingDataSilently();
                              addToast(
                                "Thành công",
                                opt.mode 
                                  ? `Đã cập nhật ${opt.label.toLowerCase()} thành công!`
                                  : "Đã khôi phục bản gốc thành công!", 
                                "success"
                              );
                            } else {
                              addToast("Lỗi", "Không thể viết lại văn bản gốc.", "error");
                            }
                          } catch (e) {
                            addToast("Lỗi", "Lỗi mạng hoặc máy chủ không phản hồi.", "error");
                          } finally {
                            setIsRewritingRaw(false);
                          }
                        }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer border ${
                          activeEditingMode === opt.mode
                            ? "bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-800/50 ring-1 ring-indigo-200 dark:ring-indigo-800/50"
                            : "text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-400 dark:hover:border-indigo-800/50"
                        }`}
                        title={opt.desc}
                      >
                        <opt.icon className="w-3.5 h-3.5" />
                        <span>{opt.label}</span>
                      </button>
                    ))}
                  </div>

                  {isRewritingRaw && (
                    <div className="mt-3 p-3 rounded-lg text-xs border bg-blue-50/50 dark:bg-blue-950/10 border-blue-200 dark:border-blue-900/30 text-blue-700 dark:text-blue-400 flex items-center gap-2.5 shadow-sm">
                      <RefreshCw className="w-4 h-4 animate-spin shrink-0 text-indigo-500" />
                      <p className="leading-relaxed">
                        <span className="font-bold mr-1.5 shrink-0 inline-flex items-center gap-1">
                          Đang xử lý:
                        </span>
                        Đang viết lại và sửa đổi văn bản bản ghi gốc bằng AI. Tiến trình này có thể mất ít giây, vòng xoay sẽ kết thúc sau khi cập nhật dữ liệu...
                      </p>
                    </div>
                  )}
                </div>

                <div className="bg-white border border-slate-200/60 dark:bg-slate-900/40 dark:border-slate-800 p-5 sm:p-6 rounded-xl shadow-sm">
                  {/* Card title */}
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
                    <FileText className="w-4.5 h-4.5 text-indigo-500" />
                    <span>Bản ghi gốc từ Deepgram</span>
                    <span className="text-xs font-normal opacity-60">({filteredTranscripts.length} đoạn)</span>
                  </div>

                  {/* Search & Language pill control bar */}
                  <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center pb-4 mb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="relative w-full sm:max-w-xs md:max-w-md">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Tìm kiếm từ khóa trong bản ghi gốc..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-8 h-9 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none shadow-sm"
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
                      <div className="flex bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/50 dark:border-slate-700/50 shadow-inner">
                        <button
                          onClick={() => setRawLangMode("original")}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                            rawLangMode === "original"
                              ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm"
                              : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                          }`}
                        >
                          Bản gốc
                        </button>
                        <button
                          onClick={() => setRawLangMode("translated")}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                            rawLangMode === "translated"
                              ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm"
                              : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                          }`}
                        >
                          Bản dịch
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-0 divide-y divide-slate-50 dark:divide-slate-800/50">
                    {filteredTranscripts.length > 0 ? filteredTranscripts.map((t: any) => (
                      <div key={t.id} className="py-2.5 first:pt-0 last:pb-0">
                        <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre-line">
                          {rawLangMode === "translated"
                            ? (t.translatedText || <span className="text-slate-400 dark:text-slate-500 italic text-xs">(Chưa có bản dịch cho câu này. Hãy chạy lại pipeline dịch ở Hội thoại)</span>)
                            : (t.correctedText || t.originalText)}
                        </p>
                      </div>
                    )) : (
                      <p className="py-12 text-center text-slate-400 italic text-sm">Không tìm thấy nội dung nào khớp với từ khóa tìm kiếm.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6 text-left">
            {/* SUB-TAB CONTENT */}
            {reprocessedTranscripts.length === 0 ? (
              <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-8 rounded-xl shadow-sm text-center space-y-2">
                <Sparkles className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto" />
                <p className="text-xs text-slate-400 italic max-w-md mx-auto">
                  Chưa có dữ liệu phân tích. Bấm <strong>"Phân tích toàn diện (Generate All)"</strong> ở trên để AI xử lý toàn bộ cuộc họp.
                </p>
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
                    const closestRaw = findClosestRawLine(t);
                    const needsReview = (typeof t.confidence === "number" && t.confidence < 0.8) || (closestRaw && typeof closestRaw.confidence === "number" && closestRaw.confidence < 0.8);
                    const hasDiff = closestRaw && (closestRaw.correctedText || closestRaw.originalText) !== (t.correctedText || t.originalText);
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
                        className={`border rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all duration-300 ${
                          activeAudioTranscriptId === t.id
                            ? "border-blue-400 dark:border-blue-600 bg-blue-50/80 dark:bg-blue-950/30 ring-1 ring-blue-200 dark:ring-blue-800"
                            : "border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-900"
                        }`}
                      >
                        <div className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700/80">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[11px] font-mono font-medium text-slate-400 ${
                                audioBlobUrl ? "cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" : ""
                              }`}
                              onClick={() => handleSeekToLine(t)}
                            >
                              {fmtTime(t.startMs)}
                            </span>
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
                              <textarea
                                value={editingTextVal}
                                onChange={(e) => setEditingTextVal(e.target.value)}
                                onBlur={() => {
                                  if (editingTextVal.trim() && editingTextVal !== initialEditingTextRef.current) {
                                    handleSaveTranscriptLine(t.id, editingTextVal, false);
                                  } else {
                                    setEditingTranscriptId(null);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    if (editingTextVal.trim() && editingTextVal !== initialEditingTextRef.current) {
                                      handleSaveTranscriptLine(t.id, editingTextVal, false);
                                    } else {
                                      setEditingTranscriptId(null);
                                    }
                                  } else if (e.key === "Escape") {
                                    setEditingTranscriptId(null);
                                  }
                                }}
                                autoFocus
                                className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
                                rows={3}
                              />
                              {isSavingLine && (
                                <span className="p-1.5 text-slate-400">
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                </span>
                              )}
                            </div>
                          ) : (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                                handleSeekToLine(t);
                              }}
                              className="group/cell leading-relaxed cursor-pointer"
                            >
                              <span className={`text-[13px] text-slate-900 dark:text-slate-100 font-semibold ${needsReview ? "bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 px-1.5 py-[1px] rounded border border-dashed border-amber-250 dark:border-amber-900/30 inline" : ""}`}>
                                {needsReview && <span className="text-amber-500 text-xs mr-1">⚠️</span>}
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
                                    activeSpeech?.id === t.id && activeSpeech?.type === "original" ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id && activeSpeech?.type === "original" ? "Dừng phát" : "Nghe gốc"}
                                >
                                  {activeSpeech?.id === t.id && activeSpeech?.type === "original" ? (
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
                                handleSeekToLine(t);
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
                                    activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                  }`}
                                  title={activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? "Dừng phát" : "Nghe dịch"}
                                >
                                  {activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? (
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
                        const closestRaw = findClosestRawLine(t);
                        const needsReview = (typeof t.confidence === "number" && t.confidence < 0.8) || (closestRaw && typeof closestRaw.confidence === "number" && closestRaw.confidence < 0.8);
                        const hasDiff = closestRaw && (closestRaw.correctedText || closestRaw.originalText) !== (t.correctedText || t.originalText);
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
                                  : "hover:bg-slate-50/50 dark:hover:bg-slate-900/50"
                              }`}
                            >
                            <td
                              className={`py-4 px-4 align-top font-medium whitespace-nowrap text-slate-400 ${
                                audioBlobUrl ? "cursor-pointer hover:text-blue-600 dark:hover:text-blue-400" : ""
                              }`}
                              onClick={() => handleSeekToLine(t)}
                              title={audioBlobUrl ? "Click để phát từ vị trí này" : undefined}
                            >
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
                                  handleSeekToLine(t);
                                }
                              }}
                              className={`py-4 px-4 align-top group/cell ${!isEditing ? "cursor-pointer" : ""}`}
                            >
                              {isEditing ? (
                                <div className="flex items-start space-x-2">
                                  <textarea
                                    value={editingTextVal}
                                    onChange={(e) => setEditingTextVal(e.target.value)}
                                    onBlur={() => {
                                      if (editingTextVal.trim() && editingTextVal !== initialEditingTextRef.current) {
                                        handleSaveTranscriptLine(t.id, editingTextVal, false);
                                      } else {
                                        setEditingTranscriptId(null);
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        if (editingTextVal.trim() && editingTextVal !== initialEditingTextRef.current) {
                                          handleSaveTranscriptLine(t.id, editingTextVal, false);
                                        } else {
                                          setEditingTranscriptId(null);
                                        }
                                      } else if (e.key === "Escape") {
                                        setEditingTranscriptId(null);
                                      }
                                    }}
                                    autoFocus
                                    className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
                                    rows={2}
                                  />
                                  {isSavingLine && (
                                    <span className="p-1.5 text-slate-400">
                                      <RefreshCw className="w-4 h-4 animate-spin" />
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="leading-relaxed">
                                  <span className={`text-slate-900 dark:text-slate-100 font-semibold ${needsReview ? "bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 px-1.5 py-[1px] rounded border border-dashed border-amber-250 dark:border-amber-900/30 inline" : ""}`}>
                                    {needsReview && <span className="text-amber-500 text-xs mr-1">⚠️</span>}
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
                                        activeSpeech?.id === t.id && activeSpeech?.type === "original" ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id && activeSpeech?.type === "original" ? "Dừng phát" : "Nghe gốc"}
                                    >
                                      {activeSpeech?.id === t.id && activeSpeech?.type === "original" ? (
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
                                handleSeekToLine(t);
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
                                        activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? "border-blue-200 dark:border-blue-900/50 text-red-500 bg-red-50 dark:bg-red-950/30 border-red-200" : ""
                                      }`}
                                      title={activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? "Dừng phát" : "Nghe dịch"}
                                    >
                                      {activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? (
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
            // Tìm dòng đang phát trong list đang hiển thị (bản gốc hoặc đã xử lý)
            // để highlight/cuộn khớp với tab người dùng đang xem.
            const activeList = transcriptVer === "ai" ? reprocessedTranscripts : transcripts;
            // Dòng đang phát = dòng có startMs lớn nhất mà vẫn <= thời điểm hiện tại.
            // Dùng "startMs gần nhất" thay vì "range chứa currentTime" để tránh bắt nhầm
            // khi các dòng có khoảng thời gian chồng lấn (find sẽ trả dòng trước đó).
            let active: any = null;
            for (const t of activeList) {
              if (currentTimeMs >= t.startMs && (!active || t.startMs > active.startMs)) {
                active = t;
              }
            }
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
      {showScrollTop && (
        <div className="fixed bottom-24 sm:bottom-28 left-0 right-0 z-50 pointer-events-none">
          <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto relative h-full">
            <button
              onClick={scrollToTop}
              className="absolute right-6 pointer-events-auto flex items-center justify-center w-11 h-11 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-full text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-500/20 shadow-md hover:shadow-lg transition-all duration-300 hover:-translate-y-1 active:translate-y-0 cursor-pointer animate-in fade-in slide-in-from-bottom-4 duration-300"
              title="Cuộn lên đầu trang"
            >
              <ChevronUp className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
