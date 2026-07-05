"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, use, Fragment } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { exportToDocx } from "@/lib/docx-helper";
import { exportToPdf } from "@/lib/pdf-helper";
import {
  ArrowLeft, FileText, Download, Play, RefreshCw, Edit2, Check, X,
  Search, Pin, Star, Trash2, Calendar, Clock, BookOpen, CheckSquare, Square, MessageSquare, Copy, Languages,
  Moon, Sun, Plus, Sparkles
} from "lucide-react";

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
  const [mainTab, setMainTab] = useState<"processed" | "raw">("processed");
  const [subTabProcessed, setSubTabProcessed] = useState<"summary" | "transcript">("summary");
  const [subTabRaw, setSubTabRaw] = useState<"summary" | "transcript">("summary");
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("aura-asteria-en");

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
  const [isSavingLine, setIsSavingLine] = useState(false);

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
  const [translatingSection, setTranslatingSection] = useState<string | null>(null);

  const handleTranslateSection = async (section: string, lang: string) => {
    setActiveTranslateDropdown(null);
    if (lang === "original") {
      if (section === "live_summary") setTranslatedExecSummary("");
      if (section === "live_decisions") setTranslatedDecisions([]);
      if (section === "raw_summary") setTranslatedReprocessedExecSummary("");
      if (section === "raw_decisions") setTranslatedReprocessedDecisions([]);
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
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, is_reprocessed,
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
            isReprocessed: t.is_reprocessed || false
          };
        });

        setTranscripts(allTranscripts.filter((t: any) => !t.isReprocessed));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.isReprocessed));
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

    } catch (err) {
      console.error(err);
      await showCustomAlert("Không thể tải thông tin cuộc họp.", "error");
      router.push("/");
    } finally {
      setLoading(false);
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
    }
  };

  const handleDeleteMeeting = async () => {
    const confirmed = await showCustomConfirm("Bạn có chắc chắn muốn xóa cuộc họp này cùng toàn bộ dữ liệu?");
    if (!confirmed) return;
    try {
      const { error } = await supabase.from("meetings").delete().eq("id", meetingId);
      if (error) throw error;
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

      // Reload all data
      await fetchMeetingData();
      await showCustomAlert("Phân tích và tách vai lại thành công!", "success");
      setMainTab("raw");
      setSubTabRaw("transcript");
    } catch (err: any) {
      console.error(err);
      await showCustomAlert("Lỗi khi xử lý lại: " + err.message, "error");
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
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")})`, "gi");
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/60 dark:text-white px-0.5 rounded">
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  const playTts = (text: string) => {
    if (!text) return;
    const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}&voice=${selectedVoice}`);
    audio.play().catch((err) => console.error(err));
  };

  // Filter transcripts by search keyword
  const filteredTranscripts = transcripts.filter((t) => {
    if (!searchQuery.trim()) return true;
    const txt = (t.correctedText || t.originalText).toLowerCase();
    const trans = (t.translatedText || "").toLowerCase();
    const query = searchQuery.toLowerCase();
    return txt.includes(query) || trans.includes(query);
  });

  const filteredReprocessedTranscripts = reprocessedTranscripts.filter((t) => {
    if (!searchQuery.trim()) return true;
    const txt = (t.correctedText || t.originalText).toLowerCase();
    const trans = (t.translatedText || "").toLowerCase();
    const query = searchQuery.toLowerCase();
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
        {/* Header skeleton */}
        <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 h-16 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="w-32 h-5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-10 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="w-10 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="w-10 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="w-28 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="w-20 h-8 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
          </div>
        </header>
        
        {/* Core container skeleton */}
        <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-8">
          <div className="flex flex-col lg:flex-row gap-8 items-start">
            {/* Left column skeleton */}
            <div className="w-full lg:w-[265px] shrink-0 space-y-6">
              {/* Tab Selector skeleton */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm space-y-3">
                <div className="w-16 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                <div className="w-full h-10 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
                <div className="w-full h-10 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
              </div>
              {/* Info card skeleton */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-5">
                <div className="w-24 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse mb-1" />
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-start space-x-3">
                    <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse mt-0.5" />
                    <div className="space-y-2 flex-1">
                      <div className="w-12 h-2.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-24 h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right column skeleton */}
            <div className="flex-1 w-full space-y-6">
              {/* Tab pills skeleton */}
              <div className="w-full h-11 rounded-xl bg-slate-200 dark:bg-slate-850 animate-pulse" />
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Summary cards skeleton */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Overview box */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
                    <div className="w-32 h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                    <div className="space-y-2.5">
                      <div className="w-full h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-[95%] h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      <div className="w-[90%] h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                    </div>
                  </div>
                  {/* Decisions box */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
                    <div className="w-28 h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                    <div className="space-y-3">
                      <div className="flex items-center space-x-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-slate-350 dark:bg-slate-750 shrink-0" />
                        <div className="w-[85%] h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-slate-350 dark:bg-slate-750 shrink-0" />
                        <div className="w-[75%] h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Assignments card skeleton */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4 h-fit">
                  <div className="w-36 h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                  <div className="space-y-4">
                    {[1, 2].map((i) => (
                      <div key={i} className="flex items-start space-x-3 border border-slate-100 dark:border-slate-800/80 p-3 rounded-lg">
                        <div className="w-4 h-4 rounded border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 animate-pulse shrink-0 mt-0.5" />
                        <div className="space-y-2 flex-1">
                          <div className="w-full h-3.5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                          <div className="w-16 h-3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
      {/* HEADER */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => router.push("/")}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer"
              title="Quay lại danh sách"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-lg leading-none" title={meeting?.title}>{meeting?.title}</h1>
          </div>

          <div className="flex items-center space-x-3">
            {/* Pin and Fav */}
            <button
              onClick={handleTogglePin}
              className={`p-2 rounded-md border cursor-pointer ${
                meeting.is_pinned
                  ? "bg-blue-50 border-blue-200 text-blue-500"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 dark:bg-slate-900 dark:border-slate-800"
              }`}
            >
              <Pin className="w-4 h-4 fill-current" />
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`p-2 rounded-md border cursor-pointer ${
                meeting.is_favorite
                  ? "bg-amber-50 border-amber-200 text-amber-500"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 dark:bg-slate-900 dark:border-slate-800"
              }`}
            >
              <Star className="w-4 h-4 fill-current" />
            </button>
            <button
              onClick={handleDeleteMeeting}
              className="p-2 border border-slate-200 text-slate-400 hover:text-red-500 hover:bg-red-50 hover:border-red-100 rounded-md dark:bg-slate-900 dark:border-slate-800 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {/* Export options */}
            <div className="relative flex items-center space-x-2 border-l border-slate-200 dark:border-slate-800 pl-4">
              <button
                onClick={handleExportDocx}
                className="flex items-center space-x-1 px-3 h-9 bg-mesh hover:bg-mesh-hover text-white rounded-md text-xs font-bold shadow-md shadow-indigo-500/15 hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Xuất Word (DOCX)</span>
              </button>
              <button
                onClick={handleExportPdf}
                className="flex items-center space-x-1 px-3 h-9 border border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900 rounded-md text-xs font-semibold transition-all text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Xuất PDF</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* CORE CONTAINER */}
      <main className="flex-1 max-w-[1366px] 2xl:max-w-[1600px] w-full mx-auto px-4 py-8">
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          
          {/* LEFT COLUMN: SIDEBAR */}
          <div className="w-full lg:w-[265px] shrink-0 space-y-6">
            {/* SCOPE NAVIGATION MENU */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm text-left">
              <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-2 mb-2 select-none">Luồng hội thoại</p>
              <div className="relative space-y-1.5">
                {/* Sliding Highlight Indicator */}
                <div 
                  className="absolute left-0 w-full bg-slate-900 dark:bg-slate-100 rounded-xl transition-all duration-300 ease-out"
                  style={{
                    height: "40px",
                    top: mainTab === "processed" ? "0px" : "46px",
                  }}
                />
                
                <button
                  onClick={() => setMainTab("processed")}
                  className={`relative z-10 w-full h-[40px] flex items-center space-x-3 px-3.5 rounded-xl text-sm font-bold transition-all cursor-pointer ${
                    mainTab === "processed"
                      ? "text-white dark:text-slate-900"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <span>Hội thoại đã xử lý</span>
                </button>
                <button
                  onClick={() => setMainTab("raw")}
                  className={`relative z-10 w-full h-[40px] flex items-center space-x-3 px-3.5 rounded-xl text-sm font-bold transition-all cursor-pointer ${
                    mainTab === "raw"
                      ? "text-white dark:text-slate-900"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  <FileText className="w-4 h-4 shrink-0" />
                  <span>Hội thoại gốc</span>
                </button>
              </div>
            </div>

            {/* METADATA INFO CARD */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-5 text-left text-xs">
              <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2">Thông tin cuộc họp</p>
              
              <div className="flex items-start space-x-3">
                <Calendar className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold uppercase">Ngày họp</p>
                  <p className="font-bold text-slate-700 dark:text-slate-350 mt-0.5">
                    {new Date(meeting.created_at).toLocaleDateString("vi-VN")}
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold uppercase">Thời lượng</p>
                  <p className="font-bold text-slate-700 dark:text-slate-350 mt-0.5">{formatDuration(meeting.duration_ms)}</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <BookOpen className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold uppercase">Ngữ cảnh</p>
                  <p className="font-bold text-slate-700 dark:text-slate-350 mt-0.5 capitalize">{meeting.meeting_context}</p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <RefreshCw className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] text-slate-400 font-semibold uppercase">Dịch thuật</p>
                  <p className="font-bold text-slate-700 dark:text-slate-350 mt-0.5">
                    {meeting.source_language.toUpperCase()} ➔ {meeting.target_language.toUpperCase()}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: MAIN CONTENT AREA */}
          <div className="flex-1 min-w-0 w-full space-y-6 text-left">
            {/* SUB-TABS SELECT CARD */}
            <div className="relative inline-flex p-1 bg-slate-100/80 dark:bg-slate-950/80 border border-slate-200/60 dark:border-slate-800/60 rounded-xl shadow-inner w-full mb-6 select-none overflow-hidden">
              {/* Sliding Background Indicator */}
              <div
                className="absolute top-1 bottom-1 left-1 rounded-lg bg-[#0f172a] dark:bg-slate-100 shadow-sm border border-slate-950/10 dark:border-slate-200/30 transition-all duration-300 ease-out"
                style={{
                  width: "calc(50% - 4px)",
                  transform:
                    (mainTab === "processed"
                      ? subTabProcessed === "transcript"
                      : subTabRaw === "transcript")
                      ? "translateX(100%)"
                      : "translateX(0%)",
                }}
              />
              {mainTab === "processed" ? (
                <>
                  <button
                    onClick={() => setSubTabProcessed("summary")}
                    className={`relative z-10 flex-1 px-4 py-1.5 text-sm font-bold rounded-lg transition-colors duration-300 cursor-pointer ${
                      subTabProcessed === "summary"
                        ? "text-white dark:text-slate-900"
                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    Tóm tắt &amp; Hành động (AI)
                  </button>
                  <button
                    onClick={() => setSubTabProcessed("transcript")}
                    className={`relative z-10 flex-1 px-4 py-1.5 text-sm font-bold rounded-lg transition-colors duration-300 cursor-pointer ${
                      subTabProcessed === "transcript"
                        ? "text-white dark:text-slate-900"
                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    Bản chi tiết ({filteredTranscripts.length})
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setSubTabRaw("summary")}
                    className={`relative z-10 flex-1 px-4 py-1.5 text-sm font-bold rounded-lg transition-colors duration-300 cursor-pointer ${
                      subTabRaw === "summary"
                        ? "text-white dark:text-slate-900"
                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    Tóm tắt &amp; Hành động (AI)
                  </button>
                  <button
                    onClick={() => setSubTabRaw("transcript")}
                    className={`relative z-10 flex-1 px-4 py-1.5 text-sm font-bold rounded-lg transition-colors duration-300 cursor-pointer ${
                      subTabRaw === "transcript"
                        ? "text-white dark:text-slate-900"
                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    Bản chi tiết ({filteredReprocessedTranscripts.length})
                  </button>
                </>
              )}
            </div>

        {/* MAIN TAB CONTENT CONTAINER */}
        {mainTab === "processed" ? (
          <div className="space-y-6 text-left">

            {/* SUB-TAB CONTENT */}
            {subTabProcessed === "summary" ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left/Middle Column: Summary & Decisions */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">1. Tóm tắt tổng quan</h3>
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

                  {/* Key Decisions */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">2. Quyết định cốt lõi</h3>
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

                {/* Right Column: Action Items Checklist */}
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">3. Phân công công việc</h3>
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

                    <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {actionItems.length === 0 ? (
                        <p className="text-sm text-slate-400 italic py-4">Không có công việc nào được phân công.</p>
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
                                    {item.description}
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
            ) : (
              <div className="space-y-6 bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm">
                {/* Internal Search & Voice selector */}
                <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div className="relative w-full max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Lọc từ khóa trong cuộc hội thoại..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-8 h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
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

                  <div className="flex items-center space-x-3 text-xs">
                    <span className="text-slate-400 font-medium">Giọng đọc phát lại:</span>
                    <select
                      value={selectedVoice}
                      onChange={(e) => setSelectedVoice(e.target.value)}
                      className="h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="aura-asteria-en">Aura Asteria (Nữ)</option>
                      <option value="aura-athena-en">Aura Athena (Nữ Anh)</option>
                      <option value="aura-orion-en">Aura Orion (Nam)</option>
                    </select>
                  </div>
                </div>

                {/* Transcript Table */}
                <div className="overflow-x-auto pr-1">
                  <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold text-xs uppercase tracking-wider">
                        <th className="py-3 px-4 text-left style-none w-16 whitespace-nowrap">Giây</th>
                        <th className="py-3 px-4 text-left style-none w-32 whitespace-nowrap">Người nói</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">Văn bản gốc</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">Bản dịch</th>
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
                            <tr className="hover:bg-slate-50/55 dark:hover:bg-slate-900/50 group">
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
                                {needsReview && (
                                  <span className="text-amber-500 font-extrabold text-xs cursor-help select-none" title="Độ tin cậy nhận diện thấp">⚠️</span>
                                )}
                              </div>
                            </td>
                            <td className="py-4 px-4 align-top">
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
                                <div 
                                  onClick={(e) => {
                                    if (isTouchDevice) {
                                      e.stopPropagation();
                                      setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                                    }
                                  }}
                                  className="group/cell flex items-start gap-2 justify-between"
                                >
                                  <div className="space-y-1 flex-1">
                                    <p className={`text-slate-900 dark:text-slate-100 font-semibold leading-relaxed ${needsReview ? "bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 px-1.5 py-[1px] rounded border border-dashed border-amber-250 dark:border-amber-900/30 inline" : ""}`}>
                                      {highlightText(t.correctedText || t.originalText, searchQuery)}
                                    </p>
                                    {t.isEdited && (
                                      <span className="text-[10px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium ml-1">
                                        Đã sửa tay
                                      </span>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`)}
                                    className={`p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-all cursor-pointer shrink-0 mt-0.5 ${activeTouchKey === `tx_orig_${t.id}` ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100'}`}
                                    title="Sao chép gốc"
                                  >
                                    {copiedKey === `tx_orig_${t.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 align-top text-slate-500 dark:text-slate-400 italic leading-relaxed">
                              <div 
                                onClick={(e) => {
                                  if (isTouchDevice) {
                                    e.stopPropagation();
                                    setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                                  }
                                }}
                                className="group/cell flex items-start gap-2 justify-between"
                              >
                                <span className="flex-1">
                                  {highlightText(t.translatedText || "", searchQuery)}
                                </span>
                                {t.translatedText && (
                                  <button
                                    onClick={() => handleCopyText(t.translatedText, `tx_trans_${t.id}`)}
                                    className={`p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-all cursor-pointer shrink-0 mt-0.5 ${activeTouchKey === `tx_trans_${t.id}` ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100'}`}
                                    title="Sao chép bản dịch"
                                  >
                                    {copiedKey === `tx_trans_${t.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="py-4 px-4 align-top text-center">
                              <div className="flex items-center justify-center space-x-1.5">
                                {t.translatedText && (
                                  <button
                                    onClick={() => playTts(t.translatedText)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer"
                                    title="Nghe giọng dịch"
                                  >
                                    <Play className="w-4 h-4 fill-current" />
                                  </button>
                                )}
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
                              <td />
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
            <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="space-y-1">
                  <h3 className="font-bold text-lg text-slate-800 dark:text-slate-200">Hội thoại gốc (Chưa xử lý)</h3>
                  <p className="text-xs text-slate-550 dark:text-slate-400">
                    Dữ liệu thô từ luồng nghe trực tiếp. Bạn có thể sử dụng Trợ lý AI đọc lại toàn bộ, phân tích ngữ cảnh và chia lại vai nói.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => {
                      const rawText = meeting?.raw_transcript || transcripts.map(t => t.originalText).join(" ");
                      handleCopyText(rawText, "raw_transcript");
                    }}
                    disabled={!meeting?.raw_transcript && transcripts.length === 0}
                    className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    title="Sao chép hội thoại gốc"
                  >
                    {copiedKey === "raw_transcript" ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>

                  <div className="flex items-center space-x-2 text-xs">
                    <span className="text-slate-500 font-medium whitespace-nowrap">Số người nói (ước lượng):</span>
                    <select
                      value={numSpeakers}
                      onChange={(e) => setNumSpeakers(e.target.value)}
                      className="h-8 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                    >
                      <option value="auto">Tự động nhận dạng</option>
                      <option value="1">1 người</option>
                      <option value="2">2 người (Mặc định đối đáp)</option>
                      <option value="3">3 người</option>
                      <option value="4">4 người</option>
                      <option value="5">5 người (Nhóm thảo luận)</option>
                    </select>
                  </div>
                  <button
                    onClick={handleReprocessRawTranscript}
                    disabled={isReprocessingRaw || (!meeting?.raw_transcript && transcripts.length === 0)}
                    className="flex items-center space-x-1.5 px-4 h-8 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isReprocessingRaw ? "animate-spin" : ""}`} />
                    <span>{isReprocessingRaw ? "Đang xử lý lại..." : "AI Phân vai lại toàn bộ"}</span>
                  </button>
                </div>
              </div>

              {/* Continuous Text Panel */}
              <div className="space-y-4">
                {isReprocessingRaw ? (
                  <div className="py-12 text-center space-y-4">
                    <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mx-auto" />
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        Trợ lý AI đang xử lý tách vai và phân tích lại hội thoại...
                      </p>
                      <p className="text-xs text-slate-400">
                        Quá trình này có thể mất từ 10 - 20 giây tùy thuộc độ dài văn bản cuộc họp.
                      </p>
                    </div>
                  </div>
                ) : meeting?.raw_transcript || transcripts.length > 0 ? (
                  <div className="p-6 bg-slate-50/50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 rounded-xl whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-300 max-h-[250px] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 scrollbar-track-transparent text-left shadow-inner">
                    {meeting?.raw_transcript || transcripts.map(t => t.originalText).join(" ")}
                  </div>
                ) : (
                  <div className="py-12 text-center text-slate-400 italic text-sm">
                    Không tìm thấy văn bản gốc chưa xử lý. Cuộc họp này có thể đã được tạo trước khi cập nhật tính năng mới.
                  </div>
                )}
              </div>
            </div>

            {/* SUB-TAB CONTENT */}
            {reprocessedTranscripts.length === 0 ? (
              <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-12 rounded-xl shadow-sm text-center">
                <p className="text-sm text-slate-450 italic">
                  Chưa có dữ liệu phân tích lại. Vui lòng chọn số người phát biểu và bấm nút <strong>"AI Phân vai lại toàn bộ"</strong> ở trên để bắt đầu xử lý toàn bộ cuộc hội thoại.
                </p>
              </div>
            ) : subTabRaw === "summary" ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left/Middle Column: Summary & Decisions */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">1. Tóm tắt tổng quan</h3>
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

                  {/* Key Decisions */}
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">2. Quyết định cốt lõi</h3>
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

                {/* Right Column: Action Items Checklist */}
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                      <h3 className="font-bold text-lg">3. Phân công công việc</h3>
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
                    </div>

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
                                    {item.description}
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
            ) : (
              <div className="space-y-6 bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm">
                {/* Internal Search & Voice selector */}
                <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div className="relative w-full max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Lọc từ khóa trong cuộc hội thoại..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-8 h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
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

                  <div className="flex items-center space-x-3 text-xs">
                    <span className="text-slate-400 font-medium">Giọng đọc phát lại:</span>
                    <select
                      value={selectedVoice}
                      onChange={(e) => setSelectedVoice(e.target.value)}
                      className="h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="aura-asteria-en">Aura Asteria (Nữ)</option>
                      <option value="aura-athena-en">Aura Athena (Nữ Anh)</option>
                      <option value="aura-orion-en">Aura Orion (Nam)</option>
                    </select>
                  </div>
                </div>

                {/* Transcript Table */}
                <div className="overflow-x-auto pr-1">
                  <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold text-xs uppercase tracking-wider">
                        <th className="py-3 px-4 text-left style-none w-16 whitespace-nowrap">Giây</th>
                        <th className="py-3 px-4 text-left style-none w-32 whitespace-nowrap">Người nói</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">Văn bản gốc</th>
                        <th className="py-3 px-4 text-left style-none w-[40%]">Bản dịch</th>
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
                            <td className="py-4 px-4 align-top">
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
                                <div 
                                  onClick={(e) => {
                                    if (isTouchDevice) {
                                      e.stopPropagation();
                                      setActiveTouchKey(activeTouchKey === `tx_orig_${t.id}` ? null : `tx_orig_${t.id}`);
                                    }
                                  }}
                                  className="group/cell flex items-start gap-2 justify-between"
                                >
                                  <div className="space-y-1 flex-1">
                                    <p className="text-slate-900 dark:text-slate-100 font-semibold leading-relaxed">
                                      {highlightText(t.correctedText || t.originalText, searchQuery)}
                                    </p>
                                    {t.isEdited && (
                                      <span className="text-[10px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium ml-1">
                                        Đã sửa tay
                                      </span>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => handleCopyText(t.correctedText || t.originalText, `tx_orig_${t.id}`)}
                                    className={`p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-all cursor-pointer shrink-0 mt-0.5 ${activeTouchKey === `tx_orig_${t.id}` ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100'}`}
                                    title="Sao chép gốc"
                                  >
                                    {copiedKey === `tx_orig_${t.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 align-top text-slate-500 dark:text-slate-400 italic leading-relaxed">
                              <div 
                                onClick={(e) => {
                                  if (isTouchDevice) {
                                    e.stopPropagation();
                                    setActiveTouchKey(activeTouchKey === `tx_trans_${t.id}` ? null : `tx_trans_${t.id}`);
                                  }
                                }}
                                className="group/cell flex items-start gap-2 justify-between"
                              >
                                <span className="flex-1">
                                  {highlightText(t.translatedText || "", searchQuery)}
                                </span>
                                {t.translatedText && (
                                  <button
                                    onClick={() => handleCopyText(t.translatedText, `tx_trans_${t.id}`)}
                                    className={`p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-all cursor-pointer shrink-0 mt-0.5 ${activeTouchKey === `tx_trans_${t.id}` ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100'}`}
                                    title="Sao chép bản dịch"
                                  >
                                    {copiedKey === `tx_trans_${t.id}` ? (
                                      <Check className="w-3.5 h-3.5 text-green-500" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="py-4 px-4 align-top text-center">
                              <div className="flex items-center justify-center space-x-1.5">
                                {t.translatedText && (
                                  <button
                                    onClick={() => playTts(t.translatedText)}
                                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 rounded transition-colors cursor-pointer"
                                    title="Nghe giọng dịch"
                                  >
                                    <Play className="w-4 h-4 fill-current" />
                                  </button>
                                )}
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
                              <td />
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
  );
}
