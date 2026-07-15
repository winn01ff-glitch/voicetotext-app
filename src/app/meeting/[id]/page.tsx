"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, use, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useDeepgramLive } from "@/hooks/useDeepgramLive";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Mic, Square, Pause, Settings, RefreshCw, Volume2, Save, HelpCircle,
  Maximize2, Minimize2, Edit, AlertCircle, VolumeX, CheckCircle, ArrowLeft, Merge, X, Sparkles, Copy, Trash2, RotateCcw, StopCircle, PhoneOff, ChevronUp,
  Moon, Sun, Plus, ChevronDown
} from "lucide-react";

interface MeetingRoomProps {
  params: Promise<{ id: string }>;
}

const getVisualLength = (str: string) => {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Japanese Hiragana, Katakana, and CJK Ideographs range
    if (
      (code >= 0x3000 && code <= 0x9fff) || 
      (code >= 0xff00 && code <= 0xffef)
    ) {
      len += 2; // CJK double-width
    } else {
      len += 1.1; // ASCII / Accent letters
    }
  }
  return len;
};

function SpeakerInput({
  initialValue,
  onSave,
}: {
  initialValue: string;
  onSave: (val: string) => void;
}) {
  const [val, setVal] = useState(initialValue);

  useEffect(() => {
    setVal(initialValue);
  }, [initialValue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val.trim() && val !== initialValue) {
          onSave(val.trim());
        }
      }}
      onKeyDown={handleKeyDown}
      className="flex-1 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-500 font-bold text-sm focus:outline-none py-1 text-slate-700 dark:text-slate-200 transition-colors"
    />
  );
}

export default function MeetingRoom({ params }: MeetingRoomProps) {
  // Unwrap params using React.use()
  const { id: meetingId } = use(params);
  const router = useRouter();
  const supabase = createClient();

  // Theme state
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Meeting states
  const [meeting, setMeeting] = useState<any>(null);
  const [speakers, setSpeakers] = useState<any[]>([]);
  const [transcripts, setTranscripts] = useState<any[]>([]); // Contains finalized and processed transcripts
  const transcriptsRef = useRef<any[]>([]);
  transcriptsRef.current = transcripts;
  const activeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [realtimeText, setRealtimeText] = useState<{
    text: string;
    interimText: string;
    speakerTag: string;
    speakerName: string;
  } | null>(null);

  // Continuous live transcript states (accumulated, no speaker labels)
  const [liveTranscriptText, setLiveTranscriptText] = useState<string>("");
  const liveTranscriptTextRef = useRef<string>("");
  liveTranscriptTextRef.current = liveTranscriptText;
  const [liveInterimText, setLiveInterimText] = useState<string>("");
  const [copiedLive, setCopiedLive] = useState(false);
  const [copiedDrafts, setCopiedDrafts] = useState(false);
  const liveScrollRef = useRef<HTMLDivElement>(null);

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

  const partialTranscript = useMemo(() => {
    if (!realtimeText) return null;
    return {
      text: (realtimeText.text + " " + realtimeText.interimText).trim(),
      speakerTag: realtimeText.speakerTag,
    };
  }, [realtimeText]);

  const [actionItems, setActionItems] = useState<any[]>([]);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [glossary, setGlossary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [selectedTargetLang, setSelectedTargetLang] = useState("vi");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [activeSpeech, setActiveSpeech] = useState<{ id: string; type: "original" | "translated" } | null>(null);
  const [lastSavedTime, setLastSavedTime] = useState<string>("");
  const [summaryProgress, setSummaryProgress] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);

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
    return voices
      .filter((v) => v.lang.toLowerCase().startsWith(selectedTargetLang.toLowerCase()))
      .map((v) => {
        // Clean name e.g. "Microsoft An - Vietnamese (Vietnam)" -> "Microsoft An"
        let cleanName = v.name.split(" - ")[0].replace(/\s*\(.*?\)\s*/g, "").trim();
        return { name: `${cleanName} (Hệ thống)`, value: v.name };
      });
  }, [voices, selectedTargetLang]);

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

  // Audio settings from localStorage
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [chunkSize, setChunkSize] = useState(250);
  const [endpointing, setEndpointing] = useState(3000);
  const [translationDelay, setTranslationDelay] = useState(5000);
  const [diarizationEnabled, setDiarizationEnabled] = useState(true);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  // Rolling summary: cheap running "who's who / topics" recap covering everything
  // before the last-30-lines window, so speaker assignment holds up beyond that window.
  const rollingSummaryRef = useRef("");
  const summarizedUpToCountRef = useRef(0);
  const ROLLING_SUMMARY_EVERY_N_BLOCKS = 10;

  // Dynamic speaker colors mapping
  const speakerColorsRef = useRef<{ [key: string]: string }>({});

  // Speaker mapping & merge states
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [showEndConfirmationModal, setShowEndConfirmationModal] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [speakerToMergeSrc, setSpeakerToMergeSrc] = useState("");
  const [speakerToMergeDest, setSpeakerToMergeDest] = useState("");

  // Toast notifications for real-time action items
  const [toasts, setToasts] = useState<any[]>([]);

  // Refs for auto-scroll
  const parentRef = useRef<HTMLDivElement>(null);
  const draftsContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const transcriptStartTimes = useRef<number>(0);
  const activeSpeakerTimeouts = useRef<Record<string, NodeJS.Timeout>>({});

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

  // Load meeting configs on mount
  useEffect(() => {
    // Check Dark Mode
    if (document.documentElement.classList.contains("dark")) {
      setIsDarkMode(true);
    }

    // Load audio options
    setEchoCancellation(localStorage.getItem("meeting_echo_cancellation") !== "false");
    setNoiseSuppression(localStorage.getItem("meeting_noise_suppression") !== "false");
    setAutoGainControl(localStorage.getItem("meeting_auto_gain_control") !== "false");
    setChunkSize(parseInt(localStorage.getItem("meeting_chunk_size") || "100"));
    setEndpointing(parseInt(localStorage.getItem("meeting_endpointing") || "3000"));
    setTranslationDelay(parseInt(localStorage.getItem("meeting_translation_delay") || "5000"));
    setDiarizationEnabled(localStorage.getItem("meeting_diarization_enabled") !== "false");

    fetchMeetingDetails();
  }, []);

  const fetchMeetingDetails = async () => {
    try {
      const { data: m, error: mErr } = await supabase
        .from("meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      if (mErr || !m) throw new Error("Meeting not found");
      setMeeting(m);
      setSelectedTargetLang(m.target_language);

      // Fetch speakers
      const { data: sps } = await supabase
        .from("speakers")
        .select("*")
        .eq("meeting_id", meetingId);

      const fetchedSpeakers = sps || [];
      setSpeakers(fetchedSpeakers);

      // Map colors
      fetchedSpeakers.forEach((s) => {
        speakerColorsRef.current[s.speaker_tag] = s.color_hex;
      });

      // Fetch live transcript text from cache
      const cachedLive = localStorage.getItem(`meeting_live_transcript_${meetingId}`);
      if (cachedLive) {
        setLiveTranscriptText(cachedLive);
        console.log("Recovered live transcript from localStorage cache");
      }

      // Recover recording duration cache
      const cachedDuration = localStorage.getItem(`meeting_recording_duration_${meetingId}`);
      if (cachedDuration) {
        const duration = parseInt(cachedDuration) || 0;
        setRecordingDuration(duration);
        if (duration > 0) {
          localStorage.setItem("active_meeting_id", meetingId);
        }
        console.log("Recovered recording duration from localStorage:", cachedDuration);
      }

      // Fetch existing transcripts (check local cache first for active recovery)
      const cachedTx = localStorage.getItem(`meeting_transcripts_${meetingId}`);
      if (cachedTx) {
        try {
          const parsed = JSON.parse(cachedTx);
          if (Array.isArray(parsed)) {
            // Reset stuck "processing" status back to "draft" on reload
            const cleaned = parsed.map((t) => 
              t.status === "processing" ? { ...t, status: "draft" } : t
            );
            setTranscripts(cleaned);
            console.log("Recovered transcripts from localStorage cache and cleaned processing states");
          }
        } catch (e) {
          console.error("Failed to parse cached transcripts:", e);
        }
      } else {
        const { data: txs } = await supabase
          .from("transcripts")
          .select(`
            id, original_text, translated_text, start_ms, end_ms, confidence, created_at,
            speakers ( display_name, color_hex, speaker_tag )
          `)
          .eq("meeting_id", meetingId)
          .order("start_ms", { ascending: true });

        if (txs) {
          setTranscripts(
            txs.map((t: any) => ({
              id: t.id,
              text: t.original_text,
              correctedText: t.original_text,
              translatedText: t.translated_text,
              speakerTag: t.speakers?.speaker_tag || "speaker_1",
              speakerName: t.speakers?.display_name || "Unknown",
              startMs: t.start_ms,
              endMs: t.end_ms,
              confidence: t.confidence,
              status: "Translated",
              createdAt: t.created_at,
            }))
          );
        }
      }

      // Fetch action items
      const { data: acts } = await supabase
        .from("action_items")
        .select("*")
        .eq("meeting_id", meetingId);
      setActionItems(acts || []);

      // Fetch glossary
      const { data: glo } = await supabase
        .from("glossary")
        .select("*")
        .eq("meeting_id", meetingId);
      setGlossary(glo || []);

      setLoading(false);
    } catch (err) {
      console.error(err);
      await showCustomAlert("Không thể tải thông tin cuộc họp.", "error");
      // replace: this /meeting/[id] URL just failed to load — leaving it in history
      // means pressing back re-triggers the same failed fetch.
      router.replace("/");
    }
  };

  const handleTargetLangChange = async (lang: string) => {
    setSelectedTargetLang(lang);
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ target_language: lang })
        .eq("id", meetingId);
      if (error) throw error;
      setMeeting((prev: any) => prev ? { ...prev, target_language: lang } : null);
    } catch (err) {
      console.error("Failed to update target language:", err);
    }
  };

  // Re-scroll to bottom on new transcripts (only when a new card is added to prevent layout thrashing)
  useEffect(() => {
    if (messagesEndRef.current && !isFullScreen) {
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [
    transcripts.filter((t) => t.status !== "draft" && t.status !== "processing").length,
    isFullScreen
  ]);

  // Sync transcripts to local cache
  useEffect(() => {
    if (meetingId && !loading) {
      if (transcripts.length > 0) {
        localStorage.setItem(`meeting_transcripts_${meetingId}`, JSON.stringify(transcripts));
        const now = new Date();
        setLastSavedTime(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`);
      } else {
        localStorage.removeItem(`meeting_transcripts_${meetingId}`);
      }
    }
  }, [transcripts, meetingId, loading]);

  // Sync live transcript to local cache
  useEffect(() => {
    if (meetingId && !loading) {
      if (liveTranscriptText) {
        localStorage.setItem(`meeting_live_transcript_${meetingId}`, liveTranscriptText);
        const now = new Date();
        setLastSavedTime(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`);
      } else {
        localStorage.removeItem(`meeting_live_transcript_${meetingId}`);
      }
    }
  }, [liveTranscriptText, meetingId, loading]);

  // Sync recording duration to local cache
  useEffect(() => {
    if (meetingId && !loading) {
      if (recordingDuration > 0) {
        localStorage.setItem(`meeting_recording_duration_${meetingId}`, recordingDuration.toString());
      } else {
        localStorage.removeItem(`meeting_recording_duration_${meetingId}`);
      }
    }
  }, [recordingDuration, meetingId, loading]);

  const removeToast = (id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  };

  const addToast = (title: string, desc: string, type: "success" | "info" | "warning" | "error" = "info") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, title, desc, type }]);
    setTimeout(() => {
      removeToast(id);
    }, 4700);
  };

  const isJapaneseText = (text: string): boolean => {
    return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
  };

  const joinWithPunctuation = (existing: string, addition: string, isJp: boolean): string => {
    if (!existing) return addition.trim();
    const trimmedExisting = existing.trim();
    const trimmedAddition = addition.trim();
    
    // Check if existing ends with punctuation
    const endsWithPunct = isJp 
      ? /[。、？！?!]/.test(trimmedExisting[trimmedExisting.length - 1])
      : /[.,?!]/.test(trimmedExisting[trimmedExisting.length - 1]);
      
    if (endsWithPunct) {
      return `${trimmedExisting} ${trimmedAddition}`;
    } else {
      const period = isJp ? "。" : ".";
      return `${trimmedExisting}${period} ${trimmedAddition}`;
    }
  };

// Hook Callback when Deepgram yields transcript


  const processTranscriptBlock = async (block: any) => {
    try {
      setTranscripts(prev => prev.map(t => t.id === block.id ? { ...t, status: "processing" } : t));
      const res = await fetch("/api/process-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          speaker_tag: block.speakerTag,
          original_text: block.text,
          start_ms: block.startMs,
          end_ms: block.endMs,
          confidence: block.confidence,
          target_language: selectedTargetLang,
        }),
      });

      if (!res.ok) {
        throw new Error("Translation failed");
      }

      const data = await res.json();

      // Update local speakers state with the real database speaker object
      if (data.speaker) {
        setSpeakers((prev) => {
          if (prev.some((s) => s.speaker_tag === data.speaker.speaker_tag && s.id === data.speaker.id)) {
            return prev;
          }
          const filtered = prev.filter((s) => s.speaker_tag !== data.speaker.speaker_tag);
          speakerColorsRef.current[data.speaker.speaker_tag] = data.speaker.color_hex;
          return [...filtered, data.speaker];
        });
      }

      setTranscripts((prev) => {
        let updated = [...prev];

        // 1. Handle corrected_previous if present
        if (data.corrected_previous_id) {
          updated = updated.map((t) => {
            if (t.id === data.corrected_previous_id) {
              return {
                ...t,
                text: data.corrected_previous_text || t.text,
                correctedText: data.corrected_previous_text || t.correctedText,
                translatedText: data.corrected_previous_translation || t.translatedText,
              };
            }
            return t;
          });
        }

        // 2. Map blocks returned from backend to frontend transcripts format
        const newTranscripts = (data.blocks || []).map((b: any) => ({
          id: b.id,
          text: b.text,
          correctedText: b.correctedText,
          translatedText: b.translatedText,
          speakerTag: b.speakerTag,
          speakerName: b.speakerName,
          startMs: block.startMs, // Fallback
          endMs: block.endMs, // Fallback
          confidence: block.confidence,
          status: "completed",
        }));

        if (data.merged && data.merged_id && newTranscripts.length > 0) {
          // The first block was merged.
          // Update the matched merged block in local state
          const targetIdx = updated.findIndex((t) => t.id === data.merged_id);
          if (targetIdx !== -1) {
            updated[targetIdx] = {
              ...updated[targetIdx],
              text: newTranscripts[0].text,
              correctedText: newTranscripts[0].correctedText,
              translatedText: newTranscripts[0].translatedText,
              endMs: block.endMs,
              status: "completed",
              speakerName: newTranscripts[0].speakerName,
            };
          }
          
          // Append the remaining blocks (if any)
          const remainingBlocks = newTranscripts.slice(1);
          return [...updated.filter((t) => t.id !== block.id), ...remainingBlocks];
        } else {
          // Normal insert of all new blocks
          // Filter out the temporary block and append the new resolved blocks
          return [...updated.filter((t) => t.id !== block.id), ...newTranscripts];
        }
      });
    } catch (err) {
      console.error(err);
      setTranscripts((prev) =>
        prev.map((t) => (t.id === block.id ? { ...t, status: "Dịch lỗi - Thử lại" } : t))
      );
    }
  };

  const finalizeAndTranslate = useCallback(async (blockId: string) => {
    let targetBlock: any = null;
    setTranscripts((prev) => {
      const block = prev.find((t) => t.id === blockId);
      if (block && block.status === "draft") {
        targetBlock = { ...block, status: "processing" };
        return prev.map((t) =>
          t.id === blockId ? { ...t, status: "processing" as any } : t
        );
      }
      return prev;
    });

    if (targetBlock) {
      processTranscriptBlock(targetBlock);
    }
  }, [meeting, meetingId, speakers]);

  const handleTranscript = useCallback(
    async (dgData: { text: string; isFinal: boolean; speechFinal: boolean; speakerTag: string; startMs: number; endMs: number; confidence: number }) => {
      if (!dgData.text.trim()) return;

      // Helper: ensure speaker color & display name exist
      const ensureSpeaker = (tag: string) => {
        if (tag && !speakerColorsRef.current[tag]) {
          const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
          const existingCount = Object.keys(speakerColorsRef.current).length;
          speakerColorsRef.current[tag] = colors[existingCount % colors.length];
        }
        const sp = speakers.find((s) => s.speaker_tag === tag);
        const name = sp ? sp.display_name : tag.replace("speaker_", "Speaker ");
        if (!sp && tag) {
          const newColor = speakerColorsRef.current[tag] || "#cbd5e1";
          setSpeakers((prev) => {
            if (prev.some((s) => s.speaker_tag === tag)) return prev;
            return [...prev, { id: `temp-${tag}`, speaker_tag: tag, display_name: name, color_hex: newColor }];
          });
        }
        return name;
      };

      // Get speaker tag from Deepgram
      const speakerTag = dgData.speakerTag || "speaker_1";
      const speakerName = ensureSpeaker(speakerTag);

      // 1. If interim (not final): update interim text for live area & fullscreen
      if (!dgData.isFinal) {
        setLiveInterimText(dgData.text);
        setRealtimeText({
          text: "",
          interimText: dgData.text,
          speakerTag,
          speakerName,
        });
        return;
      }

      // 2. If final: append raw Deepgram text to continuous live transcript & clear interim
      setLiveTranscriptText(prev => prev ? prev + " " + dgData.text : dgData.text);
      setLiveInterimText("");
      setRealtimeText(null);

      // 3. Create draft block
      const currentTranscripts = transcriptsRef.current;
      const lastBlock = currentTranscripts.length > 0 ? currentTranscripts[currentTranscripts.length - 1] : null;
      const timeGap = lastBlock ? (dgData.startMs - lastBlock.endMs) : 0;
      
      const isSameSpeaker = lastBlock && lastBlock.speakerTag === speakerTag;
      const isDraft = lastBlock && lastBlock.status === "draft";
      const isRecent = timeGap < endpointing;

      if (isSameSpeaker && isDraft && isRecent) {
        const isJp = meeting?.source_language === "ja" || meeting?.source_language === "auto";
        const joinChar = isJp ? "" : " ";
        const updatedText = (lastBlock.text + joinChar + dgData.text.trim()).trim();

        setTranscripts((prev) =>
          prev.map((t) =>
            t.id === lastBlock.id
              ? { ...t, text: updatedText, endMs: dgData.endMs }
              : t
          )
        );
      } else {
        const newBlock = {
          id: Math.random().toString(36).substr(2, 9),
          text: dgData.text.trim(),
          interimText: "",
          correctedText: "",
          translatedText: "",
          speakerTag,
          speakerName,
          startMs: typeof dgData.startMs === "number" ? dgData.startMs : 0,
          endMs: typeof dgData.endMs === "number" ? dgData.endMs : 0,
          confidence: dgData.confidence,
          status: "draft" as any,
          createdAt: new Date().toISOString(),
        };
        setTranscripts((prev) => [...prev, newBlock]);
      }
    },
    [speakers, meeting, endpointing]
  );

  const processDraftsBatch = async () => {
    const draftsToProcess = transcriptsRef.current.filter((t) => t.status === "draft" || t.status === "Dịch lỗi - Thử lại");
    if (draftsToProcess.length === 0) return;

    setIsProcessingBatch(true);

    const draftIds = draftsToProcess.map((d) => d.id);
    setTranscripts((prev) =>
      prev.map((t) =>
        draftIds.includes(t.id) ? { ...t, status: "processing" } : t
      )
    );

    const completedTranscripts = transcriptsRef.current.filter((t) => t.status !== "draft" && t.status !== "processing" && t.status !== "Dịch lỗi - Thử lại");
    const history = completedTranscripts.slice(-20).map((tx) => ({
      speaker_tag: tx.speakerTag || "unknown",
      speaker_name: tx.speakerName || "Unknown",
      text: tx.text,
      translation: tx.translatedText
    }));
    const last_transcript = completedTranscripts.length > 0 ? completedTranscripts[completedTranscripts.length - 1] : null;

    try {
      const res = await fetch("/api/process-transcript-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          history,
          last_transcript,
          target_language: selectedTargetLang,
          diarize_enabled: diarizationEnabled,
          rolling_summary: rollingSummaryRef.current,
          drafts: draftsToProcess.map((d) => ({
            id: d.id,
            speakerTag: d.speakerTag,
            speakerName: d.speakerName,
            text: d.text,
            startMs: d.startMs,
            endMs: d.endMs,
            confidence: d.confidence
          }))
        }),
      });

      if (!res.ok) {
        throw new Error("Batch translation failed");
      }

      const data = await res.json();
      const newBlocks = data.blocks || [];

      setTranscripts((prev) => {
        const filtered = prev.filter((t) => !draftIds.includes(t.id));
        const updated = [...filtered];
        newBlocks.forEach((newB: any) => {
          const idx = updated.findIndex((t) => t.id === newB.id);
          if (idx !== -1) {
            updated[idx] = newB;
          } else {
            updated.push(newB);
          }
        });
        return updated;
      });

      // Rolling summary: fire-and-forget, doesn't block the UI. Refreshed every
      // ROLLING_SUMMARY_EVERY_N_BLOCKS finalized blocks so it covers the parts of the
      // meeting that fall outside the fixed 30-line history window sent above.
      const newCompletedCount = completedTranscripts.length + newBlocks.length;
      if (newCompletedCount - summarizedUpToCountRef.current >= ROLLING_SUMMARY_EVERY_N_BLOCKS) {
        const linesForSummary = [
          ...completedTranscripts.slice(summarizedUpToCountRef.current).map((tx) => ({
            speaker_name: tx.speakerName || "Unknown",
            text: tx.text,
          })),
          ...newBlocks.map((b: any) => ({ speaker_name: b.speakerName, text: b.text })),
        ];
        summarizedUpToCountRef.current = newCompletedCount;
        fetch("/api/summarize-rolling", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previous_summary: rollingSummaryRef.current, new_lines: linesForSummary }),
        })
          .then((r) => r.json())
          .then((d) => { if (d.summary) rollingSummaryRef.current = d.summary; })
          .catch((err) => console.error("Rolling summary update failed:", err));
      }
    } catch (err) {
      console.error("Batch processing error:", err);
      setTranscripts((prev) =>
        prev.map((t) =>
          draftIds.includes(t.id) ? { ...t, status: "Dịch lỗi - Thử lại" } : t
        )
      );
    } finally {
      setIsProcessingBatch(false);
    }
  };

  // Manual retry for failed AI block
  const handleRetryAI = async (block: any) => {
    const blockId = block.id;
    setTranscripts((prev) =>
      prev.map((t) => (t.id === blockId ? { ...t, status: "processing" } : t))
    );
    try {
      const res = await fetch("/api/process-transcript-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          target_language: selectedTargetLang,
          drafts: [{
            id: block.id,
            speakerTag: block.speakerTag,
            speakerName: block.speakerName,
            text: block.text,
            startMs: block.startMs,
            endMs: block.endMs,
            confidence: block.confidence
          }]
        }),
      });

      if (!res.ok) throw new Error("Retry failed");
      const data = await res.json();
      const newBlocks = data.blocks || [];
      if (newBlocks.length > 0) {
        setTranscripts((prev) =>
          prev.map((t) => (t.id === blockId ? newBlocks[0] : t))
        );
      }
    } catch (err) {
      console.error(err);
      setTranscripts((prev) =>
        prev.map((t) => (t.id === blockId ? { ...t, status: "Dịch lỗi - Thử lại" } : t))
      );
    }
  };

  const handleMicError = (err: string) => {
    addToast("Lỗi ghi âm", err, "error");
  };

  const handleResetSettings = () => {
    setEndpointing(3000);
    setTranslationDelay(5000);
    setEchoCancellation(true);
    setNoiseSuppression(true);
    setAutoGainControl(true);
    setDiarizationEnabled(false);
    localStorage.setItem("meeting_endpointing", "3000");
    localStorage.setItem("meeting_translation_delay", "5000");
    localStorage.setItem("meeting_echo_cancellation", "true");
    localStorage.setItem("meeting_noise_suppression", "true");
    localStorage.setItem("meeting_auto_gain_control", "true");
    localStorage.setItem("meeting_diarization_enabled", "false");
    addToast("Cài đặt", "Đã khôi phục thiết lập mặc định.", "success");
  };

  const handleStatusChange = (newStatus: any) => {
    // Sync states if needed
  };

  // Initialize deepgram live recording hook
  const {
    status,
    micLevel,
    inputDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    checkMicPermission,
    startRecording,
    pauseRecording,
    stopRecording,
    setStatus,
  } = useDeepgramLive({
    meetingId,
    sourceLanguage: meeting?.source_language || "auto",
    glossary,
    chunkSize,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    endpointing,
    diarize: diarizationEnabled,
    onTranscript: handleTranscript,
    onError: handleMicError,
    onStatusChange: handleStatusChange,
  });

  // Timer for recording duration
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (status === "recording") {
      interval = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else if (status === "idle" && transcripts.length === 0) {
      setRecordingDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status, transcripts.length]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Automatically check permission and enter preparing state on load
  useEffect(() => {
    if (meeting) {
      checkMicPermission();
    }
  }, [meeting]);

  // Clear realtime transcript and finalize drafts when paused/stopped
  useEffect(() => {
    if (status !== "recording") {
      setRealtimeText(null);
      setLiveInterimText("");
      processDraftsBatch();
    }
  }, [status]);

  // Auto-scroll live transcript area to bottom
  useEffect(() => {
    if (liveScrollRef.current) {
      liveScrollRef.current.scrollTop = liveScrollRef.current.scrollHeight;
    }
  }, [liveTranscriptText, liveInterimText]);

  // Synchronize new speakers from transcripts to speakers state & database
  useEffect(() => {
    if (loading || transcripts.length === 0) return;

    const missingTags = Array.from(
      new Set(transcripts.map((t) => t.speakerTag).filter(Boolean))
    ).filter((tag) => !speakers.some((s) => s.speaker_tag === tag));

    if (missingTags.length === 0) return;

    const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

    missingTags.forEach(async (tag) => {
      if (!speakerColorsRef.current[tag]) {
        const existingCount = Object.keys(speakerColorsRef.current).length;
        speakerColorsRef.current[tag] = colors[existingCount % colors.length];
      }
      const newColor = speakerColorsRef.current[tag] || "#cbd5e1";
      const name = tag === "speaker_1" ? "Speaker 1" : tag.replace("speaker_", "Speaker ");

      setSpeakers((prev) => {
        if (prev.some((s) => s.speaker_tag === tag)) return prev;
        return [...prev, { id: `temp-${tag}`, speaker_tag: tag, display_name: name, color_hex: newColor }];
      });
    });
  }, [transcripts, speakers, loading, meetingId]);

  // Auto-process drafts when silence is detected & Auto-scroll drafts
  useEffect(() => {
    // Auto-scroll drafts container to bottom
    if (draftsContainerRef.current) {
      draftsContainerRef.current.scrollTop = draftsContainerRef.current.scrollHeight;
    }

    const drafts = transcripts.filter((t) => t.status === "draft");
    if (drafts.length === 0) return;

    const timer = setTimeout(() => {
      processDraftsBatch();
    }, translationDelay);

    return () => clearTimeout(timer);
  }, [transcripts, translationDelay]);

  // Audio Playback using Hybrid Browser Speech / Deepgram Aura 2 TTS
  // Audio Playback using Browser SpeechSynthesis with Play/Stop toggle support
  const playTtsText = (id: string, type: "original" | "translated", text: string, langCode?: string) => {
    if (!text) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      // If the clicked one is already speaking, stop it
      if (activeSpeech && activeSpeech.id === id && activeSpeech.type === type) {
        window.speechSynthesis.cancel();
        setActiveSpeech(null);
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      
      const targetLang = langCode || selectedTargetLang;
      let voiceToUse = selectedVoice;

      if (langCode && langCode !== selectedTargetLang) {
        // Find first browser voice for this language
        const brVoice = voices.find((v) => v.lang.toLowerCase().startsWith(langCode.toLowerCase()));
        voiceToUse = brVoice ? brVoice.name : "";
      }

      const voice = voices.find((v) => v.name === voiceToUse);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = targetLang === "vi" ? "vi-VN" : targetLang === "ja" ? "ja-JP" : "en-US";
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

  // Merge speakers action
  const handleMergeSpeakers = async () => {
    if (!speakerToMergeSrc || !speakerToMergeDest || speakerToMergeSrc === speakerToMergeDest) {
      addToast("Trùng người nói", "Vui lòng chọn hai người nói khác nhau.", "warning");
      return;
    }

    try {
      const srcSpeaker = speakers.find((s) => s.speaker_tag === speakerToMergeSrc);
      const destSpeaker = speakers.find((s) => s.speaker_tag === speakerToMergeDest);
      if (!srcSpeaker || !destSpeaker) return;

      // Update all transcripts of source speaker to destination speaker in DB
      const { error: updateTranscriptsError } = await supabase
        .from("transcripts")
        .update({ speaker_id: destSpeaker.id })
        .eq("meeting_id", meetingId)
        .eq("speaker_id", srcSpeaker.id);

      if (updateTranscriptsError) throw updateTranscriptsError;

      // Delete the source speaker row
      await supabase.from("speakers").delete().eq("id", srcSpeaker.id);

      // Local state update
      setSpeakers(speakers.filter((s) => s.speaker_tag !== speakerToMergeSrc));
      setTranscripts((prev) =>
        prev.map((t) =>
          t.speakerTag === speakerToMergeSrc
            ? { ...t, speakerTag: speakerToMergeDest, speakerName: destSpeaker.display_name }
            : t
        )
      );

      setShowMergeModal(false);
      addToast("Gộp thành công", `Đã gộp Speaker ${speakerToMergeSrc.replace("speaker_", "")} vào ${destSpeaker.display_name}.`, "success");
    } catch (err) {
      console.error("Merge speakers error:", err);
      addToast("Lỗi gộp người", "Không thể gộp người nói.", "error");
    }
  };

  const handleRestartMeeting = async () => {
    try {
      // Stop active recording stream if any
      stopRecording();
      setStatus("preparing");

      // 1. Delete all transcripts of this meeting from database
      const { error: deleteError } = await supabase
        .from("transcripts")
        .delete()
        .eq("meeting_id", meetingId);

      if (deleteError) throw deleteError;

      // 2. Reset local state
      setTranscripts([]);
      setRecordingDuration(0);
      setLiveTranscriptText("");
      if (liveTranscriptTextRef) {
        liveTranscriptTextRef.current = "";
      }

      // 3. Clear local storage cache
      localStorage.removeItem("active_meeting_id");
      localStorage.removeItem(`meeting_transcripts_${meetingId}`);
      localStorage.removeItem(`meeting_live_transcript_${meetingId}`);
      localStorage.removeItem(`meeting_recording_duration_${meetingId}`);

      // 4. Close modal
      setShowEndConfirmationModal(false);

      addToast("Đã làm mới", "Đã xóa sạch nội dung cuộc họp.", "success");
    } catch (err) {
      console.error("Lỗi khi bắt đầu lại cuộc họp:", err);
      addToast("Lỗi bắt đầu lại", "Không thể làm mới cuộc họp.", "error");
    }
  };

  const handleUpdateBubbleSpeaker = async (blockId: string, newSpeakerTag: string) => {
    try {
      const targetSpeaker = speakers.find((s) => s.speaker_tag === newSpeakerTag);
      if (!targetSpeaker) return;

      // Update in Supabase
      const { error } = await supabase
        .from("transcripts")
        .update({ speaker_id: targetSpeaker.id })
        .eq("id", blockId);

      if (error) throw error;

      // Update local state
      setTranscripts((prev) =>
        prev.map((t) =>
          t.id === blockId
            ? { ...t, speakerTag: targetSpeaker.speaker_tag, speakerName: targetSpeaker.display_name }
            : t
        )
      );
    } catch (err) {
      console.error("Failed to update bubble speaker:", err);
      addToast("Lỗi đổi vai", "Không thể chuyển vai người nói.", "error");
    }
  };

  // Dynamic speaker name updates
  const handleRenameSpeaker = async (speakerTag: string, newName: string) => {
    try {
      const sp = speakers.find((s) => s.speaker_tag === speakerTag);
      if (!sp) return;

      const { error } = await supabase
        .from("speakers")
        .update({ display_name: newName })
        .eq("id", sp.id);

      if (error) throw error;

      setSpeakers(speakers.map((s) => (s.speaker_tag === speakerTag ? { ...s, display_name: newName } : s)));
      setTranscripts((prev) =>
        prev.map((t) => (t.speakerTag === speakerTag ? { ...t, speakerName: newName } : t))
      );
    } catch (err) {
      console.error(err);
    }
  };

  // End meeting & trigger Quality model AI summary progress bar
  const handleEndMeeting = async () => {
    
    stopRecording();
    setIsFinishing(true);

    // Calculate duration
    let duration = 0;
    if (transcripts.length > 0) {
      duration = transcripts[transcripts.length - 1].endMs;
    }

    // Run summary progress animation
    const interval = setInterval(() => {
      setSummaryProgress((prev) => {
        if (prev >= 90) {
          clearInterval(interval);
          return 90;
        }
        return prev + 10;
      });
    }, 1500);

    try {
      const finalizedTranscripts = transcriptsRef.current.filter((t) => t.status !== "draft" && t.status !== "processing" && t.status !== "Dịch lỗi - Thử lại");
      const res = await fetch("/api/end-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: meetingId,
          duration_ms: duration,
          transcripts: finalizedTranscripts,
          raw_transcript: liveTranscriptTextRef.current,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "End meeting error");

      // Upload file âm thanh ghi âm live lên server để lưu trữ lâu dài
      try {
        const { getAudioBlob } = await import("@/lib/audio-cache");
        const audioBlob = await getAudioBlob(meetingId);
        if (audioBlob) {
          const audioFormData = new FormData();
          audioFormData.append("audio", audioBlob, `${meetingId}.webm`);
          await fetch(`/api/meetings/${meetingId}/audio`, {
            method: "POST",
            body: audioFormData,
          });
          console.log("[EndMeeting] Uploaded live audio to server successfully!");
        }
      } catch (audioErr) {
        console.warn("[EndMeeting] Failed to upload audio to server:", audioErr);
      }

      setSummaryProgress(100);
      clearInterval(interval);

      // Clean active meeting key and cached transcripts in localStorage
      localStorage.removeItem("active_meeting_id");
      localStorage.removeItem(`meeting_transcripts_${meetingId}`);
      localStorage.removeItem(`meeting_live_transcript_${meetingId}`);
      localStorage.removeItem(`meeting_recording_duration_${meetingId}`);

      // Redirect to history details. Uses replace (not push) so the now-dead
      // live-recording URL is removed from browser history — otherwise the
      // browser/mobile back button lands back on /meeting/[id] for a meeting
      // that's already "completed", which the live room isn't built to handle.
      setTimeout(() => {
        router.replace(`/history/${meetingId}`);
      }, 500);
    } catch (err) {
      console.error(err);
      clearInterval(interval);
      addToast("Lỗi kết thúc", "Không thể tạo tóm tắt cuộc họp.", "error");
      setIsFinishing(false);
      setStatus("completed");
    }
  };

  const isStarted = transcripts.length > 0 || status === "recording" || status === "processing" || recordingDuration > 0;

  if (loading) {
    return (
      <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-900/60 font-sans overflow-hidden select-none">
        <div className="flex-1 flex flex-col w-full max-w-[1366px] 2xl:max-w-[1600px] mx-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 border-x border-slate-200/60 dark:border-slate-800/80 overflow-hidden">
          {/* HEADER (Static loading view) */}
          <header className="w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between shrink-0 gap-2">
            <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
              <button
                onClick={() => router.push("/")}
                className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
                title="Quay lại danh sách"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center space-x-2 min-w-0">
                <div className="w-28 sm:w-48 h-6 rounded bg-slate-200 dark:bg-slate-800 animate-pulse shrink-0" />
              </div>
            </div>

            <div className="flex items-center space-x-1.5 sm:space-x-3 text-xs shrink-0">
              {/* Toggle control sidebar skeleton */}
              <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse shrink-0" />
              {/* Live Caption Button skeleton */}
              <div className="w-[64px] h-7 bg-slate-200 dark:bg-slate-800 animate-pulse rounded-full shrink-0" />
            </div>
          </header>

          <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
            {/* Left Column: Side Controls & Speaker Config (Static loading view) */}
            <aside className="w-full md:w-[360px] max-h-[35vh] md:max-h-full bg-white/60 dark:bg-slate-900/40 backdrop-blur-md border-b md:border-b-0 md:border-r border-slate-200/60 dark:border-slate-800 p-4 md:p-5 flex flex-col gap-4 md:gap-8 shrink-0 overflow-y-auto z-10 shadow-[2px_0_15px_-3px_rgba(0,0,0,0.05)] dark:shadow-none custom-scrollbar">
              {/* Ghi âm control */}
              <div className="space-y-4">
                <div className="h-4 w-32 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
                
                <div className="flex flex-col bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden animate-pulse">
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center space-x-2.5">
                      <span className="w-3 h-3 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                      <div className="h-5 w-16 bg-slate-200 dark:bg-slate-800 rounded"></div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-4 h-4 bg-slate-200 dark:bg-slate-800 rounded shrink-0"></div>
                      <div className="w-8 h-4 bg-slate-200 dark:bg-slate-800 rounded"></div>
                    </div>
                  </div>
                  
                  <div className="px-4 pb-4">
                    <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-800 rounded-full"></div>
                  </div>
                </div>

                {/* Controls */}
                <div className="grid grid-cols-2 gap-3 animate-pulse">
                  <div className="bg-slate-200 dark:bg-slate-800 rounded-xl h-11"></div>
                  <div className="bg-slate-200 dark:bg-slate-800 rounded-xl h-11"></div>
                </div>
              </div>

              {/* Speakers Config */}
              <div className="space-y-4 flex-1">
                <div className="flex justify-between items-center">
                  <div className="h-4 w-28 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
                  <div className="flex items-center space-x-1 px-2 py-1 shrink-0 animate-pulse">
                    <div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded shrink-0"></div>
                    <div className="h-3.5 w-14 bg-slate-200 dark:bg-slate-800 rounded"></div>
                  </div>
                </div>
                
                <div className="space-y-3 animate-pulse" style={{ marginTop: '17.8px' }}>
                  <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl p-3 shadow-sm">
                    <div className="flex items-center space-x-3">
                      <span className="w-3 h-3 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                      <div className="flex-1 py-1 flex items-center">
                        <div className="h-5 w-12 bg-slate-200 dark:bg-slate-800 rounded"></div>
                      </div>
                      <div className="px-2 py-1 rounded-md bg-slate-50 dark:bg-slate-800 shrink-0 flex items-center">
                        <div className="w-2.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Target language & Config button */}
              <div className="space-y-4 pt-6 border-t border-slate-200/60 dark:border-slate-800 animate-pulse">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center space-x-1.5">
                    <div className="w-3.5 h-3.5 bg-slate-200 dark:bg-slate-800 rounded shrink-0"></div>
                    <div className="h-3.5 w-48 bg-slate-200 dark:bg-slate-800 rounded"></div>
                  </div>
                  <div className="w-4 h-4 bg-slate-200 dark:bg-slate-800 rounded shrink-0"></div>
                </div>
              </div>
            </aside>

            {/* Main content (Static loading view) */}
            <main className="flex-1 flex flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-950 pl-4 pr-0 py-4 md:pl-5 md:pr-0 md:py-5 relative">
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none animate-pulse">
                <Mic className="w-12 h-12 text-slate-200 dark:text-slate-800 mb-4" />
                <h4 className="flex items-center justify-center h-6">
                  <span className="h-5 w-48 bg-slate-200 dark:bg-slate-800 rounded inline-block" />
                </h4>
                <p className="flex items-center justify-center mt-1 h-4">
                  <span className="h-3.5 w-80 bg-slate-200 dark:bg-slate-800 rounded inline-block" />
                </p>
              </div>

              {/* Separator Divider */}
              <div className="w-full h-[2px] bg-gradient-to-r from-blue-500/20 via-indigo-500/40 to-emerald-400/20 my-3 shrink-0 shadow-sm" />

              {/* Continuous Live Transcript Area */}
              <div className="shrink-0 bg-slate-50/40 dark:bg-slate-900/30 backdrop-blur-md border border-dashed border-slate-200 dark:border-slate-800/80 rounded-xl px-4 py-2 mr-3 flex flex-col shadow-sm animate-pulse">
                <div className="flex items-center space-x-1.5 shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" />
                  <div className="h-3 w-20 bg-slate-200 dark:bg-slate-800 rounded" />
                </div>
                <div className="h-[57px] mt-1 flex items-center">
                  <div className="h-3.5 w-48 bg-slate-200 dark:bg-slate-800 rounded" />
                </div>
              </div>

              {/* Speaker Classification Box */}
              <div className="mt-1.5 shrink-0 rounded-xl border border-dashed border-slate-200/50 dark:border-slate-800/30 bg-slate-50/10 dark:bg-slate-950/5 px-4 py-2 mr-3 flex flex-col shadow-sm animate-pulse">
                <div className="flex items-center space-x-1.5 shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" />
                  <div className="h-3 w-28 bg-slate-200 dark:bg-slate-800 rounded" />
                </div>
                <div className="h-[57px] mt-1 flex items-center">
                  <div className="h-3.5 w-40 bg-slate-200 dark:bg-slate-800 rounded" />
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    );
  }

  // If finishing, render Progress Page
  if (isFinishing) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 px-6 select-none">
        <div className="max-w-md w-full space-y-6 text-center flex flex-col items-center">
          <div className="w-14 h-14 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse mb-2 flex items-center justify-center">
            <RefreshCw className="w-6 h-6 text-blue-500 animate-spin" />
          </div>
          <div className="space-y-2 w-full">
            <h3 className="font-bold text-xl text-slate-900 dark:text-slate-100">
              Đang tạo báo cáo tóm tắt cuộc họp
            </h3>
            <p className="text-sm text-slate-500">
              Trợ lý AI đang xử lý phân tích cuộc thoại để trích xuất báo cáo tổng quan, quyết định và danh sách công việc...
            </p>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-800 h-3 rounded-full overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300"
              style={{ width: `${summaryProgress}%` }}
            ></div>
          </div>
          <span className="text-xs text-slate-400 font-medium">
            Tiến trình: {summaryProgress}% (Ước tính còn lại: {Math.max(0, 15 - Math.round((summaryProgress / 100) * 15))} giây)
          </span>
        </div>
      </div>
    );
  }

  // If in FULL SCREEN Mode, render minimal clean caption view
  if (isFullScreen) {
    const lastTxs = transcripts.filter(t => t.status !== "realtime").slice(-10); // Get last 10 stable lines
    return (
      <div className="min-h-screen w-full bg-slate-100 dark:bg-slate-900/60 flex flex-col justify-center overflow-hidden">
        <div className="flex-1 w-full max-w-[1366px] 2xl:max-w-[1600px] mx-auto bg-slate-50 dark:bg-[#0B0F19] text-slate-800 dark:text-slate-100 p-6 sm:p-12 flex flex-col justify-center relative transition-colors duration-300 border-x border-slate-200/60 dark:border-slate-800/80">
          {/* Top Header Bar */}
          <div className="absolute top-3.5 sm:top-4.5 left-4 sm:left-6 right-3 sm:right-5 flex items-center justify-between z-20">
            {/* Recording State Indicator */}
            <div className="flex items-center space-x-2">
              <span className={`w-3.5 h-3.5 bg-red-500 rounded-full ${status === "recording" ? "animate-ping" : ""}`}></span>
              <span className="text-xs text-slate-400 dark:text-slate-555 tracking-wider font-semibold">LIVE CAPTION MODE</span>
            </div>

            {/* Exit Full Screen Button */}
            <button
              onClick={() => setIsFullScreen(false)}
              style={{ marginRight: '-0.5px' }}
              className="flex items-center space-x-1 px-2.5 h-7 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-full text-[10px] font-bold tracking-wider text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer whitespace-nowrap shadow-sm"
            >
              <Minimize2 className="w-3 h-3 text-slate-400 dark:text-slate-555 -translate-y-[1px]" />
              <span>THOÁT</span>
            </button>
          </div>

        {/* Hiding scrollbar utility */}
        <style dangerouslySetInnerHTML={{__html: `
          .no-scrollbar::-webkit-scrollbar {
            display: none;
          }
          .no-scrollbar {
            -ms-overflow-style: none;
            scrollbar-width: none;
          }
        `}} />

        {/* Captions Stack */}
        <div className="max-w-5xl mx-auto w-full space-y-6 my-auto max-h-[calc(100vh-160px)] overflow-y-auto py-4 no-scrollbar">
          {lastTxs.map((t) => (
            <div key={t.id} className="animate-in fade-in slide-in-from-bottom-2 duration-200">
              <p className="text-xl md:text-3xl font-bold leading-tight">
                {t.text}
              </p>
            </div>
          ))}
          {partialTranscript && (
            <div className="opacity-60">
              <p className="text-lg md:text-2xl italic text-slate-500 dark:text-slate-355 leading-tight">
                "{partialTranscript.text}..."
              </p>
            </div>
          )}
          {transcripts.length === 0 && !partialTranscript && (
            <div className="flex flex-col items-center justify-center space-y-4 my-auto">
              <div className="flex items-center justify-center space-x-2.5">
                <span className="w-4 h-4 rounded-full bg-slate-400 dark:bg-slate-650 animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-4 h-4 rounded-full bg-slate-400 dark:bg-slate-650 animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-4 h-4 rounded-full bg-slate-400 dark:bg-slate-650 animate-bounce"></span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-900/60 font-sans overflow-hidden">
      <div className="flex-1 flex flex-col w-full max-w-[1366px] 2xl:max-w-[1600px] mx-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 border-x border-slate-200/60 dark:border-slate-800/80 overflow-hidden">
        {/* HEADER */}
      <header className="w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
          <button
            onClick={() => router.push("/")}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
            title="Quay lại danh sách"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center space-x-2 min-w-0">
            <h1 className="font-bold text-sm sm:text-lg leading-tight truncate" title={meeting?.title}>{meeting?.title}</h1>
          </div>
        </div>

        {/* Auto Save Status & Actions */}
        <div className="flex items-center space-x-1.5 sm:space-x-3 text-xs shrink-0">
          {lastSavedTime && (
            <span className="text-slate-400 font-medium flex items-center space-x-1 min-w-0 mr-1">
              <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
              <span className="hidden md:inline">Đã lưu tự động lúc {lastSavedTime} ✓</span>
              <span className="inline md:hidden">{lastSavedTime} ✓</span>
            </span>
          )}

          {/* Toggle Control Sidebar (Maximize/Minimize layout) */}
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="group flex items-center justify-center w-8 h-8 rounded-full bg-transparent hover:bg-blue-50 dark:hover:bg-blue-950/30 text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 transition-all cursor-pointer"
            title={isMaximized ? "Hiện bảng điều khiển" : "Ẩn bảng điều khiển"}
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4 transition-transform duration-200 group-hover:scale-120" />
            ) : (
              <Maximize2 className="w-4 h-4 transition-transform duration-200 group-hover:scale-120" />
            )}
          </button>

          <button
            onClick={() => setIsFullScreen(true)}
            className="flex items-center space-x-1 px-2.5 h-7 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-full text-[10px] font-bold tracking-wider text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer whitespace-nowrap shadow-sm"
            title="Mở phụ đề màn hình lớn (iPad)"
          >
            <Maximize2 className="w-3 h-3 text-slate-400 dark:text-slate-500 -translate-y-[1px]" />
            <span>LIVE</span>
          </button>
        </div>
      </header>

      {/* CORE MEETING SECTION: PC 2-Column Split */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Left Column: Side Controls & Speaker Config */}
        <aside className={`${isMaximized ? "hidden" : "w-full md:w-[360px] max-h-[35vh] md:max-h-full"} bg-white/60 dark:bg-slate-900/40 backdrop-blur-md border-b md:border-b-0 md:border-r border-slate-200/60 dark:border-slate-800 p-4 md:p-5 flex flex-col gap-4 md:gap-8 shrink-0 overflow-y-auto z-10 shadow-[2px_0_15px_-3px_rgba(0,0,0,0.05)] dark:shadow-none custom-scrollbar`}>
          {/* Ghi âm control */}
          <div className="space-y-4">
            <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400">Trạng thái ghi âm</h4>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center space-x-2.5">
                    <span
                      className={`w-3 h-3 rounded-full ${
                        status === "recording" ? "bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]" : "bg-slate-300"
                      }`}
                    ></span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                      {status === "recording" 
                        ? `Đang ghi âm (${formatDuration(recordingDuration)})` 
                        : recordingDuration > 0 
                          ? `Tạm dừng (${formatDuration(recordingDuration)})` 
                          : "Tạm dừng"}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Volume2 className="w-4 h-4 text-slate-400" />
                    <span className="text-xs font-bold text-slate-500 w-8 text-right">{micLevel}%</span>
                  </div>
                </div>
                
                <div className="px-4 pb-4">
                  <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
                    <div 
                      className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-400 transition-all duration-75" 
                      style={{ width: `${micLevel}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              {/* Controls */}
              <div className="grid grid-cols-2 gap-3 mt-1">
                {status === "recording" ? (
                  <button
                    onClick={pauseRecording}
                    className="flex items-center justify-center space-x-2 bg-blue-50 hover:bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shadow-sm"
                  >
                    <Pause className="w-4 h-4" />
                    <span>Tạm dừng</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      localStorage.setItem("active_meeting_id", meetingId);
                      startRecording();
                    }}
                    className="flex items-center justify-center space-x-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] shadow-md shadow-indigo-500/30 cursor-pointer"
                  >
                    <Mic className="w-4 h-4" />
                    <span>{transcripts.length > 0 || recordingDuration > 0 ? "Tiếp tục" : "Bắt đầu"}</span>
                  </button>
                )}

                <button
                  onClick={() => setShowEndConfirmationModal(true)}
                  disabled={!isStarted}
                  className={`flex items-center justify-center space-x-2 bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded-xl h-11 text-sm font-bold transition-all shadow-sm ${
                    !isStarted
                      ? "opacity-40 cursor-not-allowed pointer-events-none"
                      : "hover:bg-red-100 hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                  }`}
                >
                  <StopCircle className="w-4 h-4" />
                  <span>Kết thúc</span>
                </button>
              </div>

              {/* Batch Processing / Finalize Translate Button */}
              {transcripts.some((t) => t.status === "draft") && (
                <button
                  onClick={processDraftsBatch}
                  disabled={isProcessingBatch}
                  className="w-full flex items-center justify-center space-x-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 disabled:from-slate-400 disabled:to-slate-500 text-white rounded-xl h-11 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shadow-md shadow-emerald-500/20 mt-2"
                >
                  {isProcessingBatch ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Đang xử lý hội thoại...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Xử lý & Dịch hội thoại</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Speakers mappings */}
          <div className="space-y-4 flex-1">
            <div className="flex justify-between items-center">
              <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400">Người phát biểu</h4>
              <button
                onClick={() => setShowMergeModal(true)}
                className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 px-2 py-1 rounded-md flex items-center space-x-1 transition-colors cursor-pointer"
              >
                <Merge className="w-3.5 h-3.5" />
                <span>Gộp người</span>
              </button>
            </div>

            <div className="space-y-3">
              {speakers.map((s) => (
                <div key={s.id} className={`bg-white dark:bg-slate-900 border ${partialTranscript?.speakerTag === s.speaker_tag ? "border-blue-300 dark:border-blue-700 shadow-md ring-2 ring-blue-100 dark:ring-blue-900/30" : "border-slate-100 dark:border-slate-800 shadow-sm"} rounded-xl p-3 transition-all hover:shadow-md`}>
                  <div className="flex items-center space-x-3">
                    <span
                      className="w-3 h-3 rounded-full shrink-0 shadow-sm"
                      style={{ backgroundColor: s.color_hex }}
                    ></span>
                    <SpeakerInput
                      initialValue={s.display_name}
                      onSave={(newName) => handleRenameSpeaker(s.speaker_tag, newName)}
                    />
                    <span className="text-[10px] uppercase font-bold text-slate-400 select-none bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded-md">
                      {s.speaker_tag.replace("speaker_", "")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Collapsible config settings */}
          <div className="space-y-4 pt-6 border-t border-slate-200/60 dark:border-slate-800">
            <button
              onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
              className="flex items-center justify-between w-full text-left font-bold text-xs uppercase tracking-widest text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer select-none"
            >
              <span className="flex items-center space-x-1.5">
                <Settings className="w-3.5 h-3.5" />
                <span>Cấu hình giọng đọc &amp; Thiết lập</span>
              </span>
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-200 ${
                  showAdvancedSettings ? "" : "rotate-180"
                }`}
              />
            </button>

            {showAdvancedSettings && (
              <div className="space-y-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
                {status === "recording" && (
                  <div className="text-[11px] font-semibold text-red-500 dark:text-red-400 bg-red-50/50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 px-3 py-2 rounded-lg flex items-center space-x-1.5 animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                    <span>Không thể thay đổi cấu hình khi đang ghi âm. Vui lòng tạm dừng cuộc họp để chỉnh sửa.</span>
                  </div>
                )}

                {/* Voice select */}
                <div className="space-y-2">
                  <label className={`text-xs font-bold ${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-500 dark:text-slate-400"}`}>Giọng đọc (Phát âm)</label>
                  <div className="relative w-full">
                    <select
                      value={selectedVoice}
                      onChange={(e) => setSelectedVoice(e.target.value)}
                      disabled={status === "recording"}
                      className="w-full h-10 pl-3 pr-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500/50 focus:outline-none transition-all appearance-none truncate cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500 pointer-events-none" />
                  </div>
                </div>

                <div className="border-t border-slate-100 dark:border-slate-800/60 my-2"></div>

                {/* Silence timeout (Deepgram Endpointing) */}
                <div className="space-y-1.5">
                  <div className={`flex justify-between items-center text-xs font-bold ${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-500 dark:text-slate-400"}`}>
                    <span>Thời gian ngắt lời (Deepgram)</span>
                    <span className={`${status === "recording" ? "text-blue-400 dark:text-blue-500" : "text-blue-500"} font-mono`}>{(endpointing / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="relative w-full">
                    <select
                      value={endpointing}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEndpointing(val);
                        localStorage.setItem("meeting_endpointing", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-full h-9 pl-3 pr-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500/50 focus:outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="500">Nhanh nhạy (0.5s)</option>
                      <option value="1000">Tiêu chuẩn (1.0s)</option>
                      <option value="1500">Tiêu chuẩn (1.5s)</option>
                      <option value="2000">Chậm rãi (2.0s)</option>
                      <option value="3000">Mặc định (3.0s)</option>
                      <option value="5000">Cực chậm (5.0s)</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
                  </div>
                  <p className="text-[10px] text-slate-400 leading-normal">
                    Thời gian im lặng để Deepgram ngắt và hoàn thiện câu nói tạm thời.
                  </p>
                </div>

                {/* Silence timeout (AI Translation Delay) */}
                <div className="space-y-1.5">
                  <div className={`flex justify-between items-center text-xs font-bold ${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-500 dark:text-slate-400"}`}>
                    <span>Thời gian tự động dịch (AI)</span>
                    <span className={`${status === "recording" ? "text-blue-400 dark:text-blue-500" : "text-blue-500"} font-mono`}>{(translationDelay / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="relative w-full">
                    <select
                      value={translationDelay}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setTranslationDelay(val);
                        localStorage.setItem("meeting_translation_delay", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-full h-9 pl-3 pr-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500/50 focus:outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="1000">Tức thì (1.0s)</option>
                      <option value="2000">Rất nhanh (2.0s)</option>
                      <option value="3000">Tiêu chuẩn (3.0s)</option>
                      <option value="4000">Vừa phải (4.0s)</option>
                      <option value="5000">Mặc định (5.0s)</option>
                      <option value="10000">Cực chậm (10.0s)</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
                  </div>
                  <p className="text-[10px] text-slate-400 leading-normal">
                    Thời gian im lặng để AI gom câu lại và thực hiện dịch đồng bộ.
                  </p>
                </div>

                {/* Audio parameters toggles */}
                <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Xử lý âm thanh micro</label>
                  
                  <div className="flex items-center justify-between text-xs py-1">
                    <span className={`${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-350"}`}>Khử tiếng vang (Echo)</span>
                    <input
                      type="checkbox"
                      checked={echoCancellation}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setEchoCancellation(val);
                        localStorage.setItem("meeting_echo_cancellation", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs py-1">
                    <span className={`${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-350"}`}>Lọc nhiễu (Noise)</span>
                    <input
                      type="checkbox"
                      checked={noiseSuppression}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setNoiseSuppression(val);
                        localStorage.setItem("meeting_noise_suppression", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs py-1">
                    <span className={`${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-350"}`}>Tự chỉnh độ nhạy (AGC)</span>
                    <input
                      type="checkbox"
                      checked={autoGainControl}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setAutoGainControl(val);
                        localStorage.setItem("meeting_auto_gain_control", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                </div>

                {/* Diarization toggle */}
                <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <label className="text-[10px] uppercase font-bold text-slate-400">Nhận dạng người nói</label>
                  
                  <div className="flex items-center justify-between text-xs py-1">
                    <div className="flex-1 pr-2">
                      <span className={`font-medium ${status === "recording" ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-350"}`}>Phân biệt giọng nói (Diarize)</span>
                      <p className="text-[10px] text-slate-400 leading-normal mt-0.5">
                        {diarizationEnabled 
                          ? "BẬT: Dùng sóng âm để gợi ý + AI thẩm định người nói."
                          : "TẮT: AI phân vai 100% dựa trên ngữ cảnh hội thoại."
                        }
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={diarizationEnabled}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setDiarizationEnabled(val);
                        localStorage.setItem("meeting_diarization_enabled", String(val));
                      }}
                      disabled={status === "recording"}
                      className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                </div>

                <button
                  onClick={handleResetSettings}
                  disabled={status === "recording"}
                  className="w-full mt-4 py-2 border border-slate-200 dark:border-slate-800 hover:border-red-200 dark:hover:border-red-900/30 hover:bg-red-50/30 dark:hover:bg-red-950/10 rounded-lg text-xs font-semibold text-slate-500 hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 transition-all flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Khôi phục mặc định</span>
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Right Column: Real-time Transcript Virtualized Feed */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-950 pl-4 pr-0 py-4 md:pl-5 md:pr-0 md:py-5 relative">
          {transcripts.length === 0 && !partialTranscript && !liveTranscriptText ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
              <Mic className="w-12 h-12 text-slate-300 dark:text-slate-700 animate-pulse mb-4" />
              <h4 className="font-semibold text-slate-600 dark:text-slate-400">Phòng họp đã sẵn sàng</h4>
              <p className="text-xs text-slate-400 max-w-[400px] mt-1">
                Nhấn nút "Bắt đầu" để trợ lý tự động chuyển đổi ngôn ngữ thời gian thực.
              </p>
            </div>
          ) : (
            <div
              ref={parentRef}
              className="flex-1 overflow-y-auto custom-scrollbar pr-3 pb-4 space-y-4"
            >
            <div className="flex flex-col gap-2">
              {transcripts.filter((t) => t.status !== "draft" && t.status !== "processing").map((t) => {
                const needsReview = t.confidence < 0.8;
                const isDraft = t.status === "draft";
                const isProcessing = t.status === "processing";
                const isError = t.status === "Dịch lỗi - Thử lại";
                const speakerColor = speakerColorsRef.current[t.speakerTag] || "#cbd5e1";

                return (
                  <div key={t.id} className="animate-fly-up">
                    <div 
                      className="flex flex-col p-2.5 rounded-xl shadow-sm hover:shadow-md transition-all duration-300 bg-white border border-slate-100 dark:bg-slate-900 dark:border-slate-800/60 relative group border-l-4"
                      style={{ borderLeftColor: speakerColor }}
                    >
                      {/* Bubble Header */}
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center space-x-2">
                           <div className="relative inline-block" style={{ color: speakerColor }}>
                            {/* Visual pill: hugs text naturally and aligns left */}
                            <div 
                              className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center select-none"
                              style={{ backgroundColor: `${speakerColor}12` }}
                            >
                              <span>{t.speakerName}</span>
                            </div>
                            {/* Hidden native select: overlayed on top for native click picker */}
                            <select
                              value={t.speakerTag}
                              onChange={(e) => handleUpdateBubbleSpeaker(t.id, e.target.value)}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              title="Nhấp để đổi người phát biểu"
                            >
                              {speakers.map((s) => (
                                <option key={s.id} value={s.speaker_tag} className="text-slate-850 dark:text-slate-200 bg-white dark:bg-slate-900 font-semibold">
                                  {s.display_name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <span className="text-[10px] text-slate-400 font-bold bg-slate-50 dark:bg-slate-800/50 px-2 py-0.5 rounded-full" title="Giờ hiện tại">
                            {t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                          </span>
                          <span className="text-[10px] text-blue-500 dark:text-blue-400 font-extrabold bg-blue-50/60 dark:bg-blue-900/20 px-2 py-0.5 rounded-full" title="Thời gian từ lúc bắt đầu họp">
                            {(() => {
                              const elapsedSec = Math.round((t.startMs || 0) / 1000);
                              const mm = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
                              const ss = (elapsedSec % 60).toString().padStart(2, "0");
                              return `${mm}:${ss}`;
                            })()}
                          </span>
                        </div>

                        {/* Status (Right side of the Header) */}
                        <div className="flex items-center space-x-2">
                          {needsReview && (
                            <span className="flex items-center space-x-1 text-[10px] font-bold text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/30 shadow-sm" title="Độ tin cậy nhận diện thấp">
                              <AlertCircle className="w-3 h-3" />
                              <span>Cần soát lại</span>
                            </span>
                          )}
                          {isError ? (
                            <button
                              onClick={() => handleRetryAI(t)}
                              className="text-[10px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-950/40 px-2.5 py-0.5 rounded-full flex items-center space-x-1 border border-red-150 dark:border-red-900/50 shadow-sm transition-all cursor-pointer"
                            >
                              <RefreshCw className="w-2.5 h-2.5" />
                              <span>Thử lại</span>
                            </button>
                          ) : isProcessing ? (
                            <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold px-2.5 py-0.5 bg-blue-50/60 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40 rounded-full shadow-sm inline-flex items-center">
                              <span>Đang dịch</span>
                              <span className="inline-flex ml-0.5 w-4 text-left">
                                <span className="animate-pulse">.</span>
                                <span className="animate-pulse [animation-delay:200ms]">.</span>
                                <span className="animate-pulse [animation-delay:400ms]">.</span>
                              </span>
                            </span>
                          ) : isDraft ? (
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold px-2.5 py-0.5 bg-slate-50/60 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-full shadow-sm inline-flex items-center">
                              <span>Đang nghe</span>
                              <span className="inline-flex ml-0.5 w-4 text-left">
                                <span className="animate-pulse">.</span>
                                <span className="animate-pulse [animation-delay:200ms]">.</span>
                                <span className="animate-pulse [animation-delay:400ms]">.</span>
                              </span>
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {/* Bubble Body: Original and Translated Text */}
                      <div className="relative">
                        {/* Original Text Block */}
                        <div className="text-slate-800 dark:text-slate-100 text-sm font-semibold leading-relaxed whitespace-pre-wrap group/orig relative">
                          <div className="relative inline-flex items-center mr-2">
                            <span className="whitespace-pre-wrap">
                              {needsReview ? (
                                <span className="bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 px-1.5 py-[1px] rounded border border-dashed border-amber-200 dark:border-amber-900/30 inline">
                                  {t.correctedText || t.text}
                                </span>
                              ) : (
                                t.correctedText || t.text
                              )}
                            </span>
                            <button
                              onClick={() => {
                                const sp = speakers.find((s) => s.speaker_tag === t.speakerTag);
                                const langCode = sp?.language_code || meeting?.source_language || "auto";
                                const finalLangCode = langCode === "auto" ? (meeting?.source_language === "auto" ? "ja" : meeting?.source_language) : langCode;
                                playTtsText(t.id, "original", t.correctedText || t.text, finalLangCode);
                              }}
                              className={`ml-1.5 p-0.5 border rounded transition-all duration-200 delay-0 shadow-sm cursor-pointer shrink-0 ${
                                activeSpeech?.id === t.id && activeSpeech?.type === "original"
                                  ? "opacity-100 text-red-500 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900/30 animate-pulse"
                                  : "opacity-0 group-hover/orig:opacity-100 group-hover/orig:delay-[150ms] text-slate-400 hover:text-blue-600 bg-slate-50 border-slate-200 hover:bg-blue-50 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700"
                              }`}
                              title={activeSpeech?.id === t.id && activeSpeech?.type === "original" ? "Dừng phát" : "Nghe giọng gốc"}
                            >
                              {activeSpeech?.id === t.id && activeSpeech?.type === "original" ? (
                                <VolumeX className="w-2.5 h-2.5" />
                              ) : (
                                <Volume2 className="w-2.5 h-2.5" />
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Separator & Translated Text Block */}
                        {t.translatedText && (
                          <div className="mt-1.5 pt-1.5 border-t border-dashed border-slate-200 dark:border-slate-700/80 group/trans relative">
                            <div className="text-emerald-700 dark:text-emerald-400 text-[13px] leading-relaxed font-medium relative inline-flex items-center mr-2">
                              <span className="whitespace-pre-wrap">{t.translatedText}</span>
                              <button
                                onClick={() => playTtsText(t.id, "translated", t.translatedText)}
                                className={`ml-1.5 p-0.5 border rounded transition-all duration-200 delay-0 shadow-sm cursor-pointer shrink-0 ${
                                  activeSpeech?.id === t.id && activeSpeech?.type === "translated"
                                    ? "opacity-100 text-red-500 bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900/30 animate-pulse"
                                    : "opacity-0 group-hover/trans:opacity-100 group-hover/trans:delay-[150ms] text-slate-400 hover:text-blue-600 bg-slate-50 border-slate-200 hover:bg-blue-50 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700"
                                }`}
                                title={activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? "Dừng phát" : "Nghe"}
                              >
                                {activeSpeech?.id === t.id && activeSpeech?.type === "translated" ? (
                                  <VolumeX className="w-2.5 h-2.5" />
                                ) : (
                                  <Volume2 className="w-2.5 h-2.5" />
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Scroll anchor */}
              <div ref={messagesEndRef} className="h-2" />
            </div>
            </div>
          )}

          {/* Separator Divider */}
          <div className="mr-3 h-[2px] bg-gradient-to-r from-blue-500/20 via-indigo-500/40 to-emerald-400/20 my-3 shrink-0 shadow-sm"></div>

          {/* Continuous Live Transcript Area — 4 lines: title + interim + 2 scrollable */}
          <div className="shrink-0 bg-slate-50/40 dark:bg-slate-900/30 backdrop-blur-md border border-dashed border-slate-200 dark:border-slate-800/80 rounded-xl px-4 py-2 mr-3 flex flex-col shadow-sm transition-all duration-300">
            {/* Line 1: Fixed title + icons */}
            <div className="flex items-center justify-between text-[10px] font-bold tracking-wider text-slate-400 dark:text-slate-500 uppercase shrink-0">
              <div className="flex items-center space-x-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${status === "recording" ? "bg-blue-500 dark:bg-blue-400 animate-pulse" : "bg-slate-300 dark:bg-slate-700"}`}></span>
                <span className="text-blue-600 dark:text-blue-400 font-extrabold">Nghe trực tiếp</span>
              </div>
              {liveTranscriptText && (
                <div className="flex items-center space-x-1">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(liveTranscriptText);
                      setCopiedLive(true);
                      setTimeout(() => setCopiedLive(false), 1500);
                    }}
                    className={`p-1 rounded transition-all cursor-pointer ${
                      copiedLive 
                        ? "text-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 scale-110" 
                        : "text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                    title={copiedLive ? "Đã sao chép!" : "Sao chép nội dung"}
                  >
                    {copiedLive ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}
            </div>
            {/* Body: 3 scrollable lines with accumulated transcript */}
            <div 
              ref={liveScrollRef}
              className="h-[54px] overflow-y-auto no-scrollbar mt-1"
            >
              {liveTranscriptText || liveInterimText ? (
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 leading-[18px]">
                  {liveTranscriptText}
                  {liveInterimText && (
                    <span className="text-slate-400 dark:text-slate-500 italic font-medium">{liveInterimText}...</span>
                  )}
                </p>
              ) : (
                <div className="flex items-center h-full">
                  <span className="text-slate-300 dark:text-slate-700 text-xs font-medium">Đang chờ âm thanh phát biểu...</span>
                </div>
              )}
            </div>
          </div>

          {/* Speaker Classification Box — same height as live box */}
          <div className="mt-1.5 shrink-0 rounded-xl border border-dashed border-slate-200/50 dark:border-slate-800/30 bg-slate-50/10 dark:bg-slate-950/5 px-4 py-2 mr-3 flex flex-col shadow-sm">
            {/* Header */}
            <div className="flex items-center justify-between text-[10px] font-bold tracking-wider text-slate-400 dark:text-slate-500 uppercase shrink-0">
              {/* Left Side: Status, Title, and Auto 5s Badge */}
              <div className="flex items-center space-x-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${transcripts.some((t) => t.status === "processing") ? "bg-emerald-500 animate-ping" : transcripts.some((t) => t.status === "draft") ? "bg-amber-400 animate-pulse" : "bg-slate-300 dark:bg-slate-700"}`}></span>
                {transcripts.some((t) => t.status === "processing") ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-extrabold">
                    Đang phân vai...
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Phân vai người nói</span>
                )}
                {transcripts.some((t) => t.status === "draft") && !transcripts.some((t) => t.status === "processing") && (
                  <span className="hidden sm:inline-flex items-center text-[8px] text-slate-400 dark:text-slate-550 font-bold bg-slate-100/80 dark:bg-slate-800/80 px-1 h-3.5 rounded normal-case ml-1.5 shadow-sm leading-none">
                    Auto {(translationDelay / 1000).toFixed(0)}s
                  </span>
                )}
              </div>
              {/* Right Side: Phân vai ngay + Separator | + Copy + Delete */}
              {transcripts.length > 0 && (
                <div className="flex items-center space-x-1">
                  {transcripts.some((t) => t.status === "draft") && !transcripts.some((t) => t.status === "processing") && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          processDraftsBatch();
                        }}
                        disabled={isProcessingBatch}
                        className="flex items-center space-x-1 text-[9px] text-blue-600 dark:text-blue-400 font-extrabold bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-all active:scale-95 shadow-sm cursor-pointer normal-case mr-1"
                        title="Phân vai ngay lập tức"
                      >
                        <Sparkles className="w-2.5 h-2.5 animate-pulse" />
                        <span>Phân vai ngay</span>
                      </button>
                      <span className="text-slate-200 dark:text-slate-800 mx-1.5 font-normal select-none">|</span>
                    </>
                  )}
                  <button
                    onClick={() => {
                      const textToCopy = transcripts.map((d) => `${d.speakerName}: ${d.text}`).join("\n");
                      navigator.clipboard.writeText(textToCopy);
                      setCopiedDrafts(true);
                      setTimeout(() => setCopiedDrafts(false), 1500);
                    }}
                    className={`p-1 rounded transition-all cursor-pointer ${
                      copiedDrafts 
                        ? "text-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 scale-110" 
                        : "text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                    title={copiedDrafts ? "Đã sao chép!" : "Sao chép toàn bộ hội thoại gốc"}
                  >
                    {copiedDrafts ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}
            </div>
            {/* Body: 3-line scrollable draft list */}
            <div 
              ref={draftsContainerRef}
              className="h-[54px] overflow-y-auto no-scrollbar mt-1"
            >
              {(() => {
                const draftItems = transcripts.slice(-20);
                if (draftItems.length === 0) {
                  return (
                    <div className="flex items-center h-full">
                      <span className="text-[10px] text-slate-350 dark:text-slate-650 font-medium italic">Không có đoạn chờ phân vai</span>
                    </div>
                  );
                }
                return draftItems.map((draft) => {
                  const speakerColor = speakerColorsRef.current[draft.speakerTag] || "#cbd5e1";
                  const isProcessing = draft.status === "processing";
                  const isDraft = draft.status === "draft";
                  const isCompleted = !isProcessing && !isDraft;
                  return (
                    <div 
                      key={draft.id}
                      className={`leading-[18px] ${isProcessing ? "animate-pulse opacity-50" : ""} ${isCompleted ? "opacity-75" : ""}`}
                    >
                      <p className="text-xs text-slate-700 dark:text-slate-200 leading-[18px]">
                        <span className="font-extrabold" style={{ color: speakerColor }}>
                          {draft.speakerName}:
                        </span>
                        <span className="font-semibold ml-1">{draft.text}</span>
                        {isCompleted && (
                          <span className="text-[10px] text-emerald-500 ml-1.5 font-bold" title="Đã phân vai và dịch">✓</span>
                        )}
                      </p>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </main>
      </div>

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
      <div className="fixed top-1 sm:top-1.5 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 max-w-xs w-full pointer-events-none">
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

      {/* MERGE SPEAKERS MODAL */}
      {showMergeModal && (
        <div 
          onClick={() => setShowMergeModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm cursor-default"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-2xl animate-in zoom-in-95 duration-200 cursor-default"
          >
            <h3 className="font-bold text-lg mb-4 flex items-center space-x-2">
              <Merge className="w-5 h-5 text-blue-500" />
              <span>Gộp Người Phát Biểu</span>
            </h3>
            
            <p className="text-xs text-slate-500 mb-4">
              Nhập mã người nói cần gộp (Ví dụ: Speaker 3) vào người nói đích. Toàn bộ các dòng hội thoại cũ sẽ được gom về một tên duy nhất.
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Người nói nguồn (Cần gộp đi)</label>
                <select
                  value={speakerToMergeSrc}
                  onChange={(e) => setSpeakerToMergeSrc(e.target.value)}
                  className="w-full h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Chọn Speaker nguồn --</option>
                  {speakers.map((s) => (
                    <option key={s.id} value={s.speaker_tag}>
                      {s.display_name} ({s.speaker_tag.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Người nói đích (Gom vào)</label>
                <select
                  value={speakerToMergeDest}
                  onChange={(e) => setSpeakerToMergeDest(e.target.value)}
                  className="w-full h-9 px-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-xs focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Chọn Speaker đích --</option>
                  {speakers
                    .filter((s) => s.speaker_tag !== speakerToMergeSrc)
                    .map((s) => (
                      <option key={s.id} value={s.speaker_tag}>
                        {s.display_name} ({s.speaker_tag.toUpperCase()})
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowMergeModal(false)}
                className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md cursor-pointer"
              >
                Hủy bỏ
              </button>
              <button
                onClick={handleMergeSpeakers}
                className="px-4 h-9 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-md shadow-sm cursor-pointer"
              >
                Thực hiện Gộp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* END MEETING CONFIRMATION MODAL */}
      {showEndConfirmationModal && (
        <div 
          onClick={() => setShowEndConfirmationModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm cursor-default"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-2xl animate-in zoom-in-95 duration-200 cursor-default"
          >
            {/* Header with Aligned Close Button */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg flex items-center space-x-2 text-red-600 dark:text-red-500">
                <StopCircle className="w-5 h-5" />
                <span>Kết Thúc Cuộc Họp</span>
              </h3>
              
              <button
                onClick={() => setShowEndConfirmationModal(false)}
                className="p-1.5 rounded-lg border border-transparent hover:border-slate-200 dark:hover:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all cursor-pointer"
                title="Đóng"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <p className="text-sm text-slate-650 dark:text-slate-400 mb-6">
              Bạn có muốn kết thúc ghi âm cuộc họp để lưu trữ và tạo báo cáo tóm tắt thông minh (<strong>Tiếp theo</strong>), hay muốn xóa sạch dữ liệu để ghi âm lại từ đầu (<strong>Bắt đầu lại</strong>)?
            </p>

            <div className="flex flex-col sm:flex-row justify-end gap-2">
              <button
                onClick={() => setShowEndConfirmationModal(false)}
                className="px-4 h-9 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-md cursor-pointer order-3 sm:order-1 hover:border-slate-350 dark:hover:border-slate-650"
              >
                Hủy
              </button>
              <button
                onClick={() => {
                  setShowEndConfirmationModal(false);
                  handleRestartMeeting();
                }}
                className="px-4 h-9 bg-amber-50 hover:bg-amber-100 text-amber-600 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-900/50 text-xs font-semibold rounded-md shadow-sm cursor-pointer order-2 hover:border-amber-300 dark:hover:border-amber-700"
              >
                Bắt đầu lại
              </button>
              <button
                onClick={() => {
                  setShowEndConfirmationModal(false);
                  handleEndMeeting();
                }}
                className="px-4 h-9 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-md shadow-sm cursor-pointer order-1 sm:order-3 dark:bg-red-700 dark:hover:bg-red-600 border border-transparent hover:border-red-700"
              >
                Tiếp theo
              </button>
            </div>
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
                    <CheckCircle className="w-4 h-4" />
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
    </div>
  );
}
