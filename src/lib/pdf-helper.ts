export function exportToPdf(
  meeting: { title: string; created_at: string; duration_ms: number; source_language: string; target_language: string; meeting_context: string },
  speakers: { display_name: string; language_code: string }[],
  transcripts: { speaker_name: string; original_text: string; corrected_text: string; translated_text: string; start_ms: number }[],
  aiSummary: { executive_summary: string; decisions: string[] } | null,
  actionItems: { description: string; owner: string; deadline: string }[]
) {
  const dateStr = new Date(meeting.created_at).toLocaleDateString("vi-VN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = new Date(meeting.created_at).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const durationMin = Math.round(meeting.duration_ms / 60000);

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(m).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  // Build the print layout HTML
  let html = `
    <html>
    <head>
      <title>${meeting.title}</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          color: #0f172a;
          margin: 40px;
          line-height: 1.5;
        }
        h1 {
          color: #1e3a8a;
          font-size: 28px;
          margin-bottom: 5px;
          text-align: center;
        }
        .subtitle {
          color: #475569;
          font-size: 16px;
          text-align: center;
          margin-bottom: 40px;
        }
        h2 {
          color: #1e3a8a;
          border-bottom: 2px solid #e2e8f0;
          padding-bottom: 5px;
          margin-top: 30px;
          font-size: 20px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 15px;
          margin-bottom: 20px;
        }
        th, td {
          border: 1px solid #e2e8f0;
          padding: 10px;
          text-align: left;
        }
        th {
          background-color: #f8fafc;
          font-weight: 600;
          color: #334155;
        }
        .text-muted {
          color: #64748b;
          font-style: italic;
        }
        .action-table th {
          background-color: #1e3a8a;
          color: white;
        }
        .page-break {
          page-break-before: always;
        }
        @media print {
          body { margin: 20px; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <h1>${meeting.title.toUpperCase()}</h1>
      <div class="subtitle">Thời gian: ${timeStr} - ${dateStr} | Thời lượng: ${durationMin} phút</div>

      <h2>I. THÔNG TIN TỔNG QUAN</h2>
      <table>
        <tr>
          <th style="width: 30%;">Ngữ cảnh cuộc họp</th>
          <td>${meeting.meeting_context.toUpperCase()}</td>
        </tr>
        <tr>
          <th>Ngôn ngữ nguồn</th>
          <td>${meeting.source_language.toUpperCase()}</td>
        </tr>
        <tr>
          <th>Ngôn ngữ dịch đích</th>
          <td>${meeting.target_language.toUpperCase()}</td>
        </tr>
        <tr>
          <th>Người tham gia</th>
          <td>${speakers.map((s) => `${s.display_name} (${s.language_code.toUpperCase()})`).join(", ")}</td>
        </tr>
      </table>
  `;

  if (aiSummary) {
    html += `
      <h2>II. TÓM TẮT CUỘC HỌP (AI SUMMARY)</h2>
      <p><strong>Tóm tắt tổng quan:</strong> ${aiSummary.executive_summary}</p>
      
      <h3 style="margin-top: 15px; color: #475569;">Quyết định cốt lõi:</h3>
      <ul>
        ${aiSummary.decisions.map((d) => `<li>${d}</li>`).join("") || "<li>(Không có)</li>"}
      </ul>
    `;
  }

  html += `
    <h2>III. DANH SÁCH CÔNG VIỆC (ACTION ITEMS)</h2>
  `;

  if (actionItems && actionItems.length > 0) {
    html += `
      <table class="action-table">
        <thead>
          <tr>
            <th style="width: 50%;">Nội dung công việc</th>
            <th style="width: 25%;">Người thực hiện</th>
            <th style="width: 25%;">Hạn chót</th>
          </tr>
        </thead>
        <tbody>
          ${actionItems
            .map((item) => {
              let deadlineStr = "N/A";
              if (item.deadline) {
                const d = new Date(item.deadline);
                deadlineStr = isNaN(d.getTime()) ? item.deadline : d.toLocaleDateString("vi-VN") + " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
              }
              return `
                <tr>
                  <td>${item.description}</td>
                  <td>${item.owner || "N/A"}</td>
                  <td>${deadlineStr}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  } else {
    html += `<p class="text-muted">(Không có công việc nào được phân công cụ thể)</p>`;
  }

  html += `
    <div class="page-break"></div>
    <h2>IV. BẢN CHI TIẾT CUỘC HỌP</h2>
    <table>
      <thead>
        <tr>
          <th style="width: 12%;">Thời gian</th>
          <th style="width: 20%;">Người nói</th>
          <th style="width: 34%;">Nội dung gốc</th>
          <th style="width: 34%;">Bản dịch</th>
        </tr>
      </thead>
      <tbody>
        ${transcripts
          .map(
            (t) => `
            <tr>
              <td>${formatTime(t.start_ms)}</td>
              <td><strong>${t.speaker_name}</strong></td>
              <td>${t.corrected_text || t.original_text}</td>
              <td class="text-muted">${t.translated_text || ""}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
    </body>
    </html>
  `;

  // Create an iframe to trigger the browser's PDF print dialog natively
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "none";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document || iframe.contentDocument;
  if (doc) {
    doc.open();
    doc.write(html);
    doc.close();

    // Give it a short delay to load fonts/assets then trigger print
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      // Remove the iframe after printing dialog closes
      setTimeout(() => {
        document.body.removeChild(iframe);
      }, 1000);
    }, 500);
  }
}
