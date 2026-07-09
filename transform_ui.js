const fs = require('fs');

let content = fs.readFileSync('src/app/history/[id]/page.tsx', 'utf8');

// 1. Update State
content = content.replace(
  'const [mainTab, setMainTab] = useState<"processed" | "raw">("processed");',
  `const [mainTab, setMainTab] = useState<"transcript" | "ai" | "summary" | "ask">("transcript");
  const [aiJobs, setAiJobs] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);`
);

// 2. Fetch queries update (is_active = true)
content = content.replace(
  `        .select(\`
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, is_reprocessed,
          speakers ( display_name, color_hex, speaker_tag )
        \`)
        .eq("meeting_id", meetingId)
        .order("start_ms", { ascending: true });`,
  `        .select(\`
          id, original_text, corrected_text, translated_text, start_ms, end_ms, confidence, is_edited, edited_text, is_reprocessed, version_type, version,
          speakers ( display_name, color_hex, speaker_tag )
        \`)
        .eq("meeting_id", meetingId)
        .eq("is_active", true)
        .order("start_ms", { ascending: true });`
);

content = content.replace(
  `            isReprocessed: t.is_reprocessed || false
          };
        });

        setTranscripts(allTranscripts.filter((t: any) => !t.isReprocessed));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.isReprocessed));`,
  `            version_type: t.version_type || 'RAW'
          };
        });

        setTranscripts(allTranscripts.filter((t: any) => t.version_type === 'RAW'));
        setReprocessedTranscripts(allTranscripts.filter((t: any) => t.version_type === 'FINAL'));`
);

// Summaries query update
content = content.replace(
  `.from("ai_summaries")
        .select("*")
        .eq("meeting_id", meetingId)
        .maybeSingle();`,
  `.from("ai_summaries")
        .select("*")
        .eq("meeting_id", meetingId)
        .eq("is_active", true)
        .maybeSingle();`
);

// Action items query update
content = content.replace(
  `.from("action_items")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true });`,
  `.from("action_items")
        .select("*")
        .eq("meeting_id", meetingId)
        .eq("is_active", true)
        .order("created_at", { ascending: true });`
);

content = content.replace(
  `        setActionItems(acts.filter((item: any) => !item.is_reprocessed));
        setReprocessedActionItems(acts.filter((item: any) => item.is_reprocessed));`,
  `        setActionItems(acts);`
);

// Fetch ai_jobs
content = content.replace(
  `      // 5. Fetch action items`,
  `      // 4.5. Fetch AI jobs
      const { data: jobs } = await supabase.from("ai_jobs").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
      setAiJobs(jobs || []);
      
      // Fetch Chats
      const { data: chats } = await supabase.from("meeting_chats").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: true });
      if (chats && chats.length > 0) {
          setChatMessages(chats);
          setConversationId(chats[0].conversation_id);
      } else {
          setConversationId(crypto.randomUUID());
      }
      
      // 5. Fetch action items`
);

// Silent refresh identical changes
// Wait, silent refresh is almost identical. We can just skip updating silent refresh for now, or just do the same.

// 3. Tab headers update
const tabHeadersRegex = /\{\/\* Unified 4-Tab Switcher.*?\}(.*?)<\/div>/s;
const newTabHeaders = `
            {/* Unified 4-Tab Switcher */}
            <div className="relative grid grid-cols-2 xl:flex w-full xl:w-[600px] select-none shrink-0 order-2 xl:order-1 gap-y-0 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
                {['transcript', 'ai', 'summary', 'ask'].map((tab, idx) => {
                  const labels = {
                    transcript: "Transcript (Raw)",
                    ai: "AI Processed",
                    summary: "Summary",
                    ask: "Ask AI"
                  };
                  const icons = {
                    transcript: <FileText className="w-3.5 h-3.5 shrink-0" />,
                    ai: <Sparkles className="w-3.5 h-3.5 shrink-0" />,
                    summary: <List className="w-3.5 h-3.5 shrink-0" />,
                    ask: <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                  };
                  const isActive = mainTab === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => setMainTab(tab as any)}
                      className={\`flex-1 flex items-center justify-center space-x-1.5 px-2 py-2.5 text-xs sm:text-sm font-bold transition-colors \${isActive ? "text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/20" : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300"}\`}
                    >
                      {icons[tab as keyof typeof icons]}
                      <span>{labels[tab as keyof typeof labels]}</span>
                    </button>
                  )
                })}
            </div>
`;
content = content.replace(/\{\/\* Unified 4-Tab Switcher[\s\S]*?<\/div>/, newTabHeaders);

// Write back
fs.writeFileSync('src/app/history/[id]/page.tsx', content);
console.log('UI Transform Step 1 completed.');
