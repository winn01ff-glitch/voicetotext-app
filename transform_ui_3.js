const fs = require('fs');

let code = fs.readFileSync('src/app/history/[id]/page.tsx', 'utf8');

// 1. Revert State
code = code.replace(
  'const [mainTab, setMainTab] = useState<"transcript" | "ai" | "summary" | "ask">("transcript");',
  `const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "summary" | "ask">("transcript");
  const mainTab = activeTab === "summary" || activeTab === "transcript" ? "processed" : activeTab === "ask" ? "ask" : "raw";
  const subTabProcessed = activeTab === "summary" ? "summary" : "transcript";
  const subTabRaw = activeTab === "ai" ? "transcript" : "summary";`
);

// We need to remove the subTabProcessed and subTabRaw useState definitions if they exist.
code = code.replace(/const \[subTabProcessed, setSubTabProcessed\].*?;/, '');
code = code.replace(/const \[subTabRaw, setSubTabRaw\].*?;/, '');

// 2. Fix setMainTab in new tabs JSX
code = code.replace(
  `onClick={() => setMainTab(tab as any)}`,
  `onClick={() => setActiveTab(tab as any)}`
);
code = code.replace(
  `onClick={() => setMainTab(tab as any)}`,
  `onClick={() => setActiveTab(tab as any)}`
);
code = code.replace(
  `onClick={() => setMainTab(tab as any)}`,
  `onClick={() => setActiveTab(tab as any)}`
);
code = code.replace(
  `onClick={() => setMainTab(tab as any)}`,
  `onClick={() => setActiveTab(tab as any)}`
);

code = code.replace(
  /const isActive = mainTab === tab;/g,
  `const isActive = activeTab === tab;`
);

// 3. Inject Ask AI block
const askAiBlock = `) : mainTab === "ask" ? (
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
                  <div className="flex-1 p-5 overflow-y-auto space-y-4 bg-slate-50 dark:bg-slate-950">
                     {chatMessages.length === 0 && (
                       <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-3">
                         <Sparkles className="w-10 h-10 opacity-50" />
                         <p className="text-sm">Hãy đặt câu hỏi về nội dung cuộc họp</p>
                       </div>
                     )}
                     {chatMessages.map((msg, i) => (
                        <div key={i} className={\`flex \${msg.role === 'user' ? 'justify-end' : 'justify-start'}\`}>
                           <div className={\`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap \${msg.role === 'user' ? 'bg-blue-600 text-white shadow-md' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 shadow-sm'}\`}>
                              {msg.content}
                           </div>
                        </div>
                     ))}
                  </div>
                  <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
                     <form onSubmit={async (e) => {
                        e.preventDefault();
                        if (!chatInput.trim() || isChatStreaming) return;
                        const userMsg = chatInput.trim();
                        setChatInput("");
                        setChatMessages(prev => [...prev, {role: 'user', content: userMsg}]);
                        setIsChatStreaming(true);
                        try {
                           const res = await fetch('/api/meetings/ask-ai', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ meetingId, question: userMsg, conversationId })
                           });
                           if (!res.ok) throw new Error("Lỗi gọi API");
                           const reader = res.body?.getReader();
                           const decoder = new TextDecoder();
                           let aiResponse = "";
                           setChatMessages(prev => [...prev, {role: 'assistant', content: ""}]);
                           while (reader) {
                              const { done, value } = await reader.read();
                              if (done) break;
                              aiResponse += decoder.decode(value, { stream: true });
                              setChatMessages(prev => {
                                 const updated = [...prev];
                                 updated[updated.length - 1].content = aiResponse;
                                 return updated;
                              });
                           }
                        } catch(err) {
                           console.error(err);
                        } finally {
                           setIsChatStreaming(false);
                        }
                     }} className="flex gap-3">
                        <input value={chatInput} onChange={e => setChatInput(e.target.value)} disabled={isChatStreaming} placeholder="Hỏi AI..." className="flex-1 border border-slate-200 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm" />
                        <button type="submit" disabled={isChatStreaming} className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-6 py-3 rounded-xl text-sm font-semibold hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 shadow-md transition-all flex items-center justify-center">
                          {isChatStreaming ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Gửi"}
                        </button>
                     </form>
                  </div>
               </div>
          </div>
) : subTabRaw === "summary" ? (`;

code = code.replace(`) : subTabRaw === "summary" ? (`, askAiBlock);

// 4. Inject Control Panel inside the AI Transcript block
const controlPanelBlock = `
{filteredReprocessedTranscripts.length === 0 && (
    <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-8 rounded-xl shadow-sm text-center space-y-6 max-w-2xl mx-auto mb-6">
      <Sparkles className="w-12 h-12 text-indigo-500 mx-auto" />
      <div>
         <h3 className="text-xl font-bold text-slate-800 dark:text-slate-200">Trợ lý AI Phân tích</h3>
         <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">Dữ liệu gốc đã có. Hãy chạy pipeline AI để phân vai, sửa lỗi, và tạo tóm tắt.</p>
      </div>
      
      {aiJobs.length > 0 && aiJobs.some(j => j.status !== 'cancelled') ? (
         <div className="space-y-4 text-left border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-slate-50 dark:bg-slate-950">
            <h4 className="font-semibold text-sm text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800 pb-2">Tiến trình xử lý</h4>
            {aiJobs.map(job => (
               <div key={job.id} className="flex flex-col space-y-1">
                 <div className="flex items-center justify-between text-xs font-medium">
                   <span className="text-slate-700 dark:text-slate-300 capitalize">{job.type}</span>
                   <span className={job.status === 'completed' ? 'text-green-600' : job.status === 'failed' ? 'text-red-600' : 'text-blue-600'}>{job.status}</span>
                 </div>
                 <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                   <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: \`\${job.progress || 0}%\` }}></div>
                 </div>
               </div>
            ))}
            
            {aiJobs.some(j => j.status === 'processing' || j.status === 'queued') && (
               <div className="flex justify-end pt-2">
                 <button onClick={async () => {
                    const activeJob = aiJobs.find(j => j.status === 'processing' || j.status === 'queued');
                    if (activeJob) {
                       await fetch('/api/meetings/reprocess/cancel-job', { method: 'POST', body: JSON.stringify({ jobId: activeJob.id }) });
                    }
                 }} className="text-xs text-red-600 hover:underline px-2 py-1">Huỷ tiến trình</button>
               </div>
            )}
         </div>
      ) : (
         <button onClick={async () => {
             const res = await fetch('/api/meetings/reprocess/run-queue', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ meetingId, jobTypes: ['spellcheck', 'speaker', 'translation', 'summary'] })
             });
             if (res.ok) {
                 setTimeout(refreshMeetingDataSilently, 1000);
             }
         }} className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 text-white font-semibold py-3 px-4 rounded-xl shadow-lg shadow-indigo-200 dark:shadow-none hover:from-indigo-700 hover:to-blue-700 transition-all flex items-center justify-center space-x-2">
           <Play className="w-4 h-4 fill-current" />
           <span>Phân tích toàn diện (Generate All)</span>
         </button>
      )}
    </div>
)}
{filteredReprocessedTranscripts.length > 0 ? (
`;

// Replace the empty block check with our new control panel.
// Old code:
// {filteredReprocessedTranscripts.length === 0 ? (
//   <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-8 rounded-xl shadow-sm text-center space-y-2">
//     <Sparkles className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto" />
//     <p className="text-xs text-slate-400 italic max-w-md mx-auto">
//       Chưa có dữ liệu phân tích lại. Chọn số người phát biểu và bấm <strong>"AI Phân vai"</strong> ở trên để bắt đầu.
//     </p>
//   </div>
// ) : (

const regexToReplaceEmptyAiList = /\{filteredReprocessedTranscripts\.length === 0 \? \([\s\S]*?\) : \(/;
code = code.replace(regexToReplaceEmptyAiList, controlPanelBlock);

// Replace the closing brace for the ternary.
// wait, we replaced `{filteredReprocessedTranscripts.length === 0 ? ( ... ) : (`
// with `{filteredReprocessedTranscripts.length === 0 && ( ... )} {filteredReprocessedTranscripts.length > 0 ? (`
// So the closing brace `)}` of the original ternary is still perfectly valid for our new ternary!
// `{filteredReprocessedTranscripts.length > 0 ? ( ... ) : null}` wait, no!
// In the original it was `? ( empty ) : ( non-empty )}`
// If I replaced it with `? (` then the end should be `) : null}`.
// Let's change the replacement:
const fixedControlPanelBlock = `
{filteredReprocessedTranscripts.length === 0 ? (
    <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-8 rounded-xl shadow-sm text-center space-y-6 max-w-2xl mx-auto mb-6">
      <Sparkles className="w-12 h-12 text-indigo-500 mx-auto" />
      <div>
         <h3 className="text-xl font-bold text-slate-800 dark:text-slate-200">Trợ lý AI Phân tích</h3>
         <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">Dữ liệu gốc đã có. Hãy chạy pipeline AI để phân vai, sửa lỗi, và tạo tóm tắt.</p>
      </div>
      
      {aiJobs.length > 0 && aiJobs.some(j => j.status !== 'cancelled') ? (
         <div className="space-y-4 text-left border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-slate-50 dark:bg-slate-950">
            <h4 className="font-semibold text-sm text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800 pb-2">Tiến trình xử lý</h4>
            {aiJobs.map(job => (
               <div key={job.id} className="flex flex-col space-y-1">
                 <div className="flex items-center justify-between text-xs font-medium">
                   <span className="text-slate-700 dark:text-slate-300 capitalize">{job.type}</span>
                   <span className={job.status === 'completed' ? 'text-green-600' : job.status === 'failed' ? 'text-red-600' : 'text-blue-600'}>{job.status}</span>
                 </div>
                 <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                   <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: \`\${job.progress || 0}%\` }}></div>
                 </div>
               </div>
            ))}
            
            {aiJobs.some(j => j.status === 'processing' || j.status === 'queued') && (
               <div className="flex justify-end pt-2">
                 <button onClick={async () => {
                    const activeJob = aiJobs.find(j => j.status === 'processing' || j.status === 'queued');
                    if (activeJob) {
                       await fetch('/api/meetings/reprocess/cancel-job', { method: 'POST', body: JSON.stringify({ jobId: activeJob.id }) });
                    }
                 }} className="text-xs text-red-600 hover:underline px-2 py-1">Huỷ tiến trình</button>
               </div>
            )}
         </div>
      ) : (
         <button onClick={async () => {
             const res = await fetch('/api/meetings/reprocess/run-queue', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ meetingId, jobTypes: ['spellcheck', 'speaker', 'translation', 'summary'] })
             });
             if (res.ok) {
                 setTimeout(refreshMeetingDataSilently, 1000);
             }
         }} className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 text-white font-semibold py-3 px-4 rounded-xl shadow-lg shadow-indigo-200 dark:shadow-none hover:from-indigo-700 hover:to-blue-700 transition-all flex items-center justify-center space-x-2">
           <Play className="w-4 h-4 fill-current" />
           <span>Phân tích toàn diện (Generate All)</span>
         </button>
      )}
    </div>
) : (`;

code = code.replace(regexToReplaceEmptyAiList, fixedControlPanelBlock);

fs.writeFileSync('src/app/history/[id]/page.tsx', code);
console.log('Done script 3');
