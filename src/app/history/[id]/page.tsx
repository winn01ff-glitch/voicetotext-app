"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { exportToDocx } from "@/lib/docx-helper";
import { exportToPdf } from "@/lib/pdf-helper";
import {
  ArrowLeft, FileText, Download, Play, RefreshCw, Edit2, Check,
  Search, Pin, Star, Trash2, Calendar, Clock, BookOpen, CheckSquare, Square
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
  const [transcripts, setTranscripts] = useState<any[]>([]);
  const [aiSummary, setAiSummary] = useState<any>(null);
  const [actionItems, setActionItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [activeTab, setActiveTab] = useState<"summary" | "transcript">("summary");
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("aura-asteria-en");

  // Editing state for AI Summary
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editedExecSummary, setEditedExecSummary] = useState("");
  const [editedDecisions, setEditedDecisions] = useState<string[]>([]);
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);

  // Editing state for transcripts lines
  const [editingTranscriptId, setEditingTranscriptId] = useState<string | null>(null);
  const [editingTextVal, setEditingTextVal] = useState("");

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
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text,
          speakers ( display_name, color_hex, speaker_tag )
        `)
        .eq("meeting_id", meetingId)
        .order("start_ms", { ascending: true });

      if (txs) {
        setTranscripts(
          txs.map((t: any) => ({
            id: t.id,
            originalText: t.original_text,
            correctedText: t.corrected_text,
            translatedText: t.translated_text,
            speakerName: t.speakers?.display_name || "Unknown",
            speakerTag: t.speakers?.speaker_tag || "speaker_0",
            speakerColor: t.speakers?.color_hex || "#64748b",
            startMs: t.start_ms,
            endMs: t.end_ms,
            confidence: t.confidence,
            isEdited: t.is_edited,
            editedText: t.edited_text,
          }))
        );
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
      }

      // 5. Fetch action items
      const { data: acts } = await supabase
        .from("action_items")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });
      setActionItems(acts || []);

    } catch (err) {
      console.error(err);
      alert("Không thể tải thông tin cuộc họp.");
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
    if (!confirm("Bạn có chắc chắn muốn xóa cuộc họp này cùng toàn bộ dữ liệu?")) return;
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

  // Manual Edit AI Summary save
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

      setAiSummary({
        ...aiSummary,
        executive_summary: editedExecSummary,
        decisions: editedDecisions,
      });
      setIsEditingSummary(false);
    } catch (err) {
      console.error(err);
      alert("Lỗi khi lưu tóm tắt cuộc họp.");
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
    if (!confirm("Tải lại tóm tắt bằng Gemini Quality Model? Thao tác này sẽ ghi đè lên các Action Items cũ.")) return;
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
      alert("Cập nhật tóm tắt thành công!");
    } catch (err) {
      console.error(err);
      alert("Lỗi khi tạo lại tóm tắt cuộc họp.");
    } finally {
      setIsRegeneratingSummary(false);
    }
  };

  // Edit transcript line text
  const startEditingTranscript = (line: any) => {
    setEditingTranscriptId(line.id);
    setEditingTextVal(line.correctedText || line.originalText);
  };

  const handleSaveTranscriptLine = async (lineId: string) => {
    try {
      const { error } = await supabase
        .from("transcripts")
        .update({
          is_edited: true,
          edited_text: editingTextVal,
          corrected_text: editingTextVal, // Update corrected text directly for search/display
        })
        .eq("id", lineId);

      if (error) throw error;

      setTranscripts(
        transcripts.map((t) =>
          t.id === lineId
            ? { ...t, isEdited: true, editedText: editingTextVal, correctedText: editingTextVal }
            : t
        )
      );
      setEditingTranscriptId(null);
    } catch (err) {
      console.error(err);
      alert("Lỗi khi lưu dòng biên bản.");
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

  const formatDuration = (ms: number) => {
    if (!ms) return "0 phút";
    const mins = Math.round(ms / 60000);
    return `${mins} phút`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mb-4" />
        <span className="text-slate-500 font-medium">Đang tải lịch sử cuộc họp...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
      {/* HEADER */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => router.push("/")}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-lg leading-tight">{meeting.title}</h1>
          </div>

          <div className="flex items-center space-x-3">
            {/* Pin and Fav */}
            <button
              onClick={handleTogglePin}
              className={`p-2 rounded-md border ${
                meeting.is_pinned
                  ? "bg-blue-50 border-blue-200 text-blue-500"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 dark:bg-slate-900 dark:border-slate-800"
              }`}
            >
              <Pin className="w-4 h-4 fill-current" />
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`p-2 rounded-md border ${
                meeting.is_favorite
                  ? "bg-amber-50 border-amber-200 text-amber-500"
                  : "bg-white border-slate-200 text-slate-400 hover:text-slate-600 dark:bg-slate-900 dark:border-slate-800"
              }`}
            >
              <Star className="w-4 h-4 fill-current" />
            </button>
            <button
              onClick={handleDeleteMeeting}
              className="p-2 border border-slate-200 text-slate-400 hover:text-red-500 hover:bg-red-50 hover:border-red-100 rounded-md dark:bg-slate-900 dark:border-slate-800"
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
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 space-y-6">
        {/* INFO OVERVIEW */}
        <section className="glass p-6 rounded-2xl shadow-lg shadow-indigo-500/5 grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
          <div className="flex items-start space-x-2">
            <Calendar className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase">Ngày họp</p>
              <p className="font-semibold text-slate-700 dark:text-slate-300">
                {new Date(meeting.created_at).toLocaleDateString("vi-VN")}
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-2">
            <Clock className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase">Thời lượng</p>
              <p className="font-semibold text-slate-700 dark:text-slate-300">{formatDuration(meeting.duration_ms)}</p>
            </div>
          </div>
          <div className="flex items-start space-x-2">
            <BookOpen className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase">Ngữ cảnh</p>
              <p className="font-semibold text-slate-700 dark:text-slate-300 capitalize">{meeting.meeting_context}</p>
            </div>
          </div>
          <div className="flex items-start space-x-2">
            <RefreshCw className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase">Dịch thuật</p>
              <p className="font-semibold text-slate-700 dark:text-slate-300">
                {meeting.source_language.toUpperCase()} ➔ {meeting.target_language.toUpperCase()}
              </p>
            </div>
          </div>
        </section>

        {/* TABS SELECT */}
        <div className="flex border-b border-slate-200 dark:border-slate-800">
          <button
            onClick={() => setActiveTab("summary")}
            className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all ${
              activeTab === "summary"
                ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            }`}
          >
            Tóm tắt &amp; Hành động (AI)
          </button>
          <button
            onClick={() => setActiveTab("transcript")}
            className={`pb-3 px-4 font-semibold text-sm border-b-2 transition-all ${
              activeTab === "transcript"
                ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            }`}
          >
            Biên bản chi tiết ({filteredTranscripts.length})
          </button>
        </div>

        {/* TAB CONTENTS */}
        {activeTab === "summary" ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left/Middle Column: Summary & Decisions */}
            <div className="lg:col-span-2 space-y-6">
              {/* Executive Summary */}
              <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                  <h3 className="font-bold text-lg">1. Tóm tắt tổng quan</h3>
                  {!isEditingSummary && (
                    <div className="flex space-x-2">
                      <button
                        onClick={handleRegenerateSummary}
                        disabled={isRegeneratingSummary}
                        className="flex items-center space-x-1 px-3 h-8 border border-slate-200 text-xs font-semibold rounded-md hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-300 disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isRegeneratingSummary ? "animate-spin" : ""}`} />
                        <span>Tạo lại (AI)</span>
                      </button>
                      <button
                        onClick={() => setIsEditingSummary(true)}
                        className="flex items-center space-x-1 px-3 h-8 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 rounded-md text-xs font-semibold"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>Sửa tay</span>
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
                    {aiSummary?.executive_summary || "Chưa có bản tóm tắt nào cho cuộc họp này. Bạn có thể nhấn 'Tạo lại (AI)' để tạo."}
                  </p>
                )}
              </div>

              {/* Key Decisions */}
              <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
                  <h3 className="font-bold text-lg">2. Quyết định cốt lõi</h3>
                  {isEditingSummary && (
                    <button
                      onClick={handleAddDecisionField}
                      className="text-xs font-semibold text-blue-500 hover:text-blue-600 flex items-center space-x-0.5"
                    >
                      <span>+ Thêm quyết định</span>
                    </button>
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
                          className="p-1.5 text-slate-400 hover:text-red-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ul className="space-y-2.5">
                    {aiSummary?.decisions && aiSummary.decisions.length > 0 ? (
                      aiSummary.decisions.map((dec: string, idx: number) => (
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
                      className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md"
                    >
                      Hủy bỏ
                    </button>
                    <button
                      onClick={handleSaveSummary}
                      disabled={isSavingSummary}
                      className="flex items-center space-x-1.5 px-4 h-9 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md shadow-sm transition-colors"
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
                <h3 className="font-bold text-lg pb-2 border-b border-slate-100 dark:border-slate-800">
                  3. Phân công công việc (Action Items)
                </h3>

                <div className="space-y-4">
                  {actionItems.length === 0 ? (
                    <p className="text-sm text-slate-400 italic">Không có công việc nào được phân công.</p>
                  ) : (
                    actionItems.map((item) => {
                      let deadlineStr = "N/A";
                      if (item.deadline) {
                        const d = new Date(item.deadline);
                        deadlineStr = isNaN(d.getTime()) ? item.deadline : d.toLocaleDateString("vi-VN") + " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
                      }

                      return (
                        <div
                          key={item.id}
                          className={`p-3.5 border rounded-lg flex items-start space-x-3 transition-all ${
                            item.is_completed
                              ? "bg-slate-50 border-slate-200 opacity-60 dark:bg-slate-900/40 dark:border-slate-800"
                              : "bg-white border-blue-100 hover:border-blue-200 dark:bg-slate-900 dark:border-slate-800 dark:hover:border-slate-700"
                          }`}
                        >
                          <button
                            onClick={() => handleToggleActionItem(item.id, item.is_completed)}
                            className={`p-1 shrink-0 rounded transition-colors ${
                              item.is_completed ? "text-green-500" : "text-slate-400 hover:text-blue-500"
                            }`}
                          >
                            {item.is_completed ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                          </button>
                          
                          <div className="flex-1 space-y-1">
                            <p
                              className={`text-sm font-semibold leading-snug text-slate-800 dark:text-slate-200 ${
                                item.is_completed ? "line-through text-slate-400 dark:text-slate-500" : ""
                              }`}
                            >
                              {item.description}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                              <span>Phụ trách: <strong>{item.owner || "Chưa gán"}</strong></span>
                              <span>•</span>
                              <span>Hạn: <strong>{deadlineStr}</strong></span>
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
          /* TAB TRANSCRIPT VIEW */
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
                  className="w-full pl-9 pr-4 h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
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
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold">
                    <th className="py-3 px-4 text-left style-none w-16">Giây</th>
                    <th className="py-3 px-4 text-left style-none w-32">Người nói</th>
                    <th className="py-3 px-4 text-left style-none w-[40%]">Văn bản gốc</th>
                    <th className="py-3 px-4 text-left style-none w-[40%]">Bản dịch</th>
                    <th className="py-3 px-4 text-center style-none w-20">Công cụ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredTranscripts.map((t) => {
                    const isEditing = editingTranscriptId === t.id;
                    const formatTime = (ms: number) => {
                      const s = Math.floor(ms / 1000);
                      const m = Math.floor(s / 60);
                      const secs = s % 60;
                      return `${String(m).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
                    };

                    return (
                      <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50 group">
                        <td className="py-4 px-4 align-top text-slate-400 font-medium whitespace-nowrap">
                          {formatTime(t.startMs)}
                        </td>
                        <td className="py-4 px-4 align-top whitespace-nowrap">
                          <span
                            className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded text-xs font-semibold"
                            style={{ backgroundColor: `${t.speakerColor}15`, color: t.speakerColor }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.speakerColor }}></span>
                            <span>{t.speakerName}</span>
                          </span>
                        </td>
                        <td className="py-4 px-4 align-top">
                          {isEditing ? (
                            <div className="flex items-start space-x-2">
                              <textarea
                                value={editingTextVal}
                                onChange={(e) => setEditingTextVal(e.target.value)}
                                className="flex-1 p-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
                                rows={2}
                              />
                              <button
                                onClick={() => handleSaveTranscriptLine(t.id)}
                                className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <p className="text-slate-900 dark:text-slate-100 font-semibold leading-relaxed">
                                {highlightText(t.correctedText || t.originalText, searchQuery)}
                              </p>
                              {t.isEdited && (
                                <span className="text-[10px] bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 px-1 rounded font-medium">
                                  Đã sửa tay
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-4 align-top text-slate-500 dark:text-slate-400 italic leading-relaxed">
                          {highlightText(t.translatedText || "", searchQuery)}
                        </td>
                        <td className="py-4 px-4 align-top text-center">
                          <div className="flex items-center justify-center space-x-1.5">
                            {t.translatedText && (
                              <button
                                onClick={() => playTts(t.translatedText)}
                                className="p-1 text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
                                title="Nghe giọng dịch"
                              >
                                <Play className="w-4 h-4 fill-current" />
                              </button>
                            )}
                            {!isEditing && (
                              <button
                                onClick={() => startEditingTranscript(t)}
                                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
                                title="Chỉnh sửa văn bản"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
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
      </main>
    </div>
  );
}
