import { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, BorderStyle, TextRun, PageBreak } from "docx";

export async function exportToDocx(
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

  // Border styles for cleaner look
  const tableBorders = {
    top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "F1F5F9" },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "F1F5F9" },
  };

  // Helper to format timestamp
  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(m).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  // 1. Cover Page Elements
  const coverPage = [
    new Paragraph({ text: "" }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "BẢN CHI TIẾT HỌP ĐA NGÔN NGỮ",
          bold: true,
          size: 32,
          color: "1E3A8A",
          font: "Geist Sans",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: meeting.title.toUpperCase(),
          bold: true,
          size: 40,
          color: "0F172A",
          font: "Geist Sans",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Thời gian: ${timeStr} - ${dateStr}`,
          size: 24,
          italics: true,
          color: "475569",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Thời lượng: ${durationMin} phút`,
          size: 24,
          color: "475569",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "" }),
    new Paragraph({ text: "" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Được khởi tạo tự động bởi Antigravity Voice Assistant",
          size: 20,
          color: "94A3B8",
        }),
      ],
    }),
    new PageBreak(),
  ];

  // 2. Meeting Overview
  const overviewSection = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: "I. Thông Tin Tổng Quan",
          bold: true,
          color: "1E3A8A",
          font: "Geist Sans",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorders,
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              shading: { fill: "F8FAFC" },
              children: [new Paragraph({ children: [new TextRun({ text: "Ngữ cảnh họp", bold: true, color: "334155" })] })],
            }),
            new TableCell({
              width: { size: 70, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ text: meeting.meeting_context.toUpperCase() })],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: "F8FAFC" },
              children: [new Paragraph({ children: [new TextRun({ text: "Ngôn ngữ nguồn", bold: true, color: "334155" })] })],
            }),
            new TableCell({
              children: [new Paragraph({ text: meeting.source_language.toUpperCase() })],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: "F8FAFC" },
              children: [new Paragraph({ children: [new TextRun({ text: "Ngôn ngữ đích", bold: true, color: "334155" })] })],
            }),
            new TableCell({
              children: [new Paragraph({ text: meeting.target_language.toUpperCase() })],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: "F8FAFC" },
              children: [new Paragraph({ children: [new TextRun({ text: "Người tham gia", bold: true, color: "334155" })] })],
            }),
            new TableCell({
              children: [
                new Paragraph({
                  text: speakers.map((s) => `${s.display_name} (${s.language_code.toUpperCase()})`).join(", "),
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    new Paragraph({ text: "" }),
  ];

  // 3. AI Summary Section
  const summarySection = [];
  if (aiSummary) {
    summarySection.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: "II. Tóm Tắt & Quyết Định Chính",
            bold: true,
            color: "1E3A8A",
            font: "Geist Sans",
          }),
        ],
      }),
      new Paragraph({ text: "" }),
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "1. Tóm tắt tổng quan (Executive Summary)", bold: true, color: "475569" })],
      }),
      new Paragraph({ text: aiSummary.executive_summary }),
      new Paragraph({ text: "" }),
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "2. Quyết định cốt lõi", bold: true, color: "475569" })],
      })
    );

    if (aiSummary.decisions && aiSummary.decisions.length > 0) {
      aiSummary.decisions.forEach((d) => {
        summarySection.push(new Paragraph({ text: `• ${d}`, bullet: { level: 0 } }));
      });
    } else {
      summarySection.push(new Paragraph({ children: [new TextRun({ text: "(Không có quyết định cụ thể nào được đưa ra)", italics: true })] }));
    }
    summarySection.push(new Paragraph({ text: "" }));
  }

  // 4. Action Items Section
  const actionSection: any[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: "III. Danh Sách Công Việc (Action Items)",
          bold: true,
          color: "1E3A8A",
          font: "Geist Sans",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
  ];

  if (actionItems && actionItems.length > 0) {
    const actionRows = [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            shading: { fill: "1E3A8A" },
            children: [new Paragraph({ children: [new TextRun({ text: "Nội dung công việc", bold: true, color: "FFFFFF" })] })],
          }),
          new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: "1E3A8A" },
            children: [new Paragraph({ children: [new TextRun({ text: "Người chịu trách nhiệm", bold: true, color: "FFFFFF" })] })],
          }),
          new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: "1E3A8A" },
            children: [new Paragraph({ children: [new TextRun({ text: "Hạn chót", bold: true, color: "FFFFFF" })] })],
          }),
        ],
      }),
    ];

    actionItems.forEach((item) => {
      let deadlineStr = "N/A";
      if (item.deadline) {
        const d = new Date(item.deadline);
        deadlineStr = isNaN(d.getTime()) ? item.deadline : d.toLocaleDateString("vi-VN") + " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      }
      actionRows.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ text: item.description })] }),
            new TableCell({ children: [new Paragraph({ text: item.owner || "N/A" })] }),
            new TableCell({ children: [new Paragraph({ text: deadlineStr })] }),
          ],
        })
      );
    });

    actionSection.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders, rows: actionRows }));
  } else {
    actionSection.push(new Paragraph({ children: [new TextRun({ text: "(Không có công việc nào được phân công cụ thể)", italics: true })] }));
  }
  actionSection.push(new Paragraph({ text: "" }), new PageBreak());

  // 5. Full Transcript Table
  const transcriptRows = [
    new TableRow({
      children: [
        new TableCell({
          width: { size: 10, type: WidthType.PERCENTAGE },
          shading: { fill: "F1F5F9" },
          children: [new Paragraph({ children: [new TextRun({ text: "Thời gian", bold: true, color: "334155" })] })],
        }),
        new TableCell({
          width: { size: 20, type: WidthType.PERCENTAGE },
          shading: { fill: "F1F5F9" },
          children: [new Paragraph({ children: [new TextRun({ text: "Người phát biểu", bold: true, color: "334155" })] })],
        }),
        new TableCell({
          width: { size: 35, type: WidthType.PERCENTAGE },
          shading: { fill: "F1F5F9" },
          children: [new Paragraph({ children: [new TextRun({ text: "Nội dung gốc", bold: true, color: "334155" })] })],
        }),
        new TableCell({
          width: { size: 35, type: WidthType.PERCENTAGE },
          shading: { fill: "F1F5F9" },
          children: [new Paragraph({ children: [new TextRun({ text: "Bản dịch", bold: true, color: "334155" })] })],
        }),
      ],
    }),
  ];

  transcripts.forEach((t) => {
    transcriptRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ text: formatTime(t.start_ms) })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.speaker_name, bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ text: t.corrected_text || t.original_text })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.translated_text || "", italics: true, color: "475569" })] })] }),
        ],
      })
    );
  });

  const transcriptSection = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: "IV. Bản Chi Tiết Cuộc Họp",
          bold: true,
          color: "1E3A8A",
          font: "Geist Sans",
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableBorders,
      rows: transcriptRows,
    }),
  ];

  // Combine document sections
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [...coverPage, ...overviewSection, ...summarySection, ...actionSection, ...transcriptSection],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${meeting.title.replace(/[^a-zA-Z0-9_ -]/g, "")}_minutes.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
