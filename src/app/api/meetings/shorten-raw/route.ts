import { NextResponse } from "next/server";
import { SchemaType } from "@google/generative-ai";
import { callGemini } from "@/lib/ai/pipeline";

const AI_MODEL = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";

const SHORTEN_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: { shortened: { type: SchemaType.STRING } },
  required: ["shortened"],
};

/**
 * Rút gọn bản ghi THÔ (chỉ để hiển thị + copy ở frontend — KHÔNG lưu DB).
 * Giữ nguyên ý, chỉ cô đọng lại; không dịch, không thêm thông tin.
 */
export async function POST(request: Request) {
  try {
    const { text } = await request.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "Thiếu nội dung cần rút gọn." }, { status: 400 });
    }

    const prompt = `
Bạn là biên tập viên. Hãy RÚT GỌN đoạn bản ghi dưới đây thành phiên bản cô đọng, dễ đọc.

QUY TẮC BẮT BUỘC:
1. GIỮ NGUYÊN NGÔN NGỮ GỐC — KHÔNG dịch.
2. GIỮ NGUYÊN Ý NGHĨA — không thêm thông tin, không bịa, không đổi số liệu/tên riêng.
3. Bỏ từ đệm/lặp, câu thừa; gộp ý trùng; giữ lại mọi ý chính.
4. Chỉ trả về văn bản đã rút gọn (không giải thích).

BẢN GHI GỐC:
---
${text}
---
`;

    const result = await callGemini<{ shortened: string }>(prompt, AI_MODEL, {
      temperature: 0.2,
      responseSchema: SHORTEN_SCHEMA,
      maxOutputTokens: 8192,
    });

    return NextResponse.json({ shortened: result?.shortened || "" });
  } catch (error) {
    console.error("Shorten raw error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
