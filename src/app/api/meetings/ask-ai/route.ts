import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateEmbeddings } from "@/lib/ai/rag";

const AI_MODEL = process.env.AI_QUALITY_MODEL || "gemini-2.5-pro";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768; // Khớp với cột vector(768) và RPC match_transcript_chunks

export async function POST(req: Request) {
  try {
    const { meetingId, question, conversationId } = await req.json();

    if (!meetingId || !question) {
      return NextResponse.json({ error: "Thiếu meetingId hoặc câu hỏi" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Lưu câu hỏi của user vào meeting_chats
    const { data: userMsg } = await supabase.from("meeting_chats").insert({
      meeting_id: meetingId,
      conversation_id: conversationId || null,
      role: "user",
      content: question,
    }).select().single();

    // Lấy history của conversation
    let historyText = "";
    if (conversationId) {
       const { data: history } = await supabase
         .from("meeting_chats")
         .select("role, content")
         .eq("conversation_id", conversationId)
         .order("created_at", { ascending: true })
         .limit(10);
       
       if (history) {
         historyText = history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join("\n");
       }
    }

    // 2. RAG: Kiểm tra embeddings
    const { count } = await supabase
      .from("transcript_embeddings")
      .select("*", { count: "exact", head: true })
      .eq("meeting_id", meetingId);

    if (!count || count === 0) {
      console.log(`[Ask AI] Chưa có embeddings cho meeting ${meetingId}. Đang tạo On-demand...`);
      await generateEmbeddings(meetingId);
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const embeddingModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const aiModel = genAI.getGenerativeModel({ model: AI_MODEL });

    // 3. Tạo vector cho câu hỏi
    const embedResult = await embeddingModel.embedContent({
      content: { role: "user", parts: [{ text: question }] },
      outputDimensionality: EMBEDDING_DIM,
    } as any);
    const queryEmbedding = embedResult.embedding.values;

    // 4. Tìm context bằng RPC match_transcript_chunks
    const { data: chunks, error: rpcError } = await supabase.rpc("match_transcript_chunks", {
      query_embedding: queryEmbedding,
      p_meeting_id: meetingId,
      match_threshold: 0.5,
      match_count: 5,
    });

    if (rpcError) {
      console.error("[Ask AI] Lỗi gọi RPC match_transcript_chunks:", rpcError);
    }

    const contextText = chunks && chunks.length > 0
      ? chunks.map((c: any) => c.content).join("\n\n---\n\n")
      : "(Không tìm thấy thông tin cụ thể trong bản ghi, hãy trả lời dựa trên hiểu biết hoặc báo không tìm thấy)";

    // 5. Chuẩn bị Prompt
    const prompt = `Bạn là trợ lý AI thân thiện, trò chuyện tự nhiên như ChatGPT, giúp người dùng hiểu và khai thác nội dung cuộc họp.

LỊCH SỬ TRÒ CHUYỆN:
${historyText}

NGỮ CẢNH CUỘC HỌP (trích từ bản ghi):
${contextText}

CÂU HỎI MỚI: ${question}

HƯỚNG DẪN:
- Trả lời tự nhiên, thân thiện, bằng chính ngôn ngữ của người dùng.
- Nếu người dùng chỉ chào hỏi hoặc trò chuyện xã giao (vd "chào", "alo", "có gì hot"), hãy đáp lại niềm nở và gợi ý vài điều họ có thể hỏi về cuộc họp.
- Nếu câu hỏi mơ hồ hoặc thiếu thông tin, hãy CHỦ ĐỘNG HỎI LẠI để làm rõ ý người dùng, thay vì từ chối trả lời.
- Với câu hỏi về nội dung cuộc họp: ưu tiên dựa vào NGỮ CẢNH ở trên. KHÔNG bịa ra chi tiết cụ thể (số liệu, tên riêng, quyết định) không có trong ngữ cảnh; nếu ngữ cảnh chưa đủ, hãy nói thật và hỏi người dùng muốn tập trung vào phần nào.
- Có thể dùng kiến thức chung để giải thích khái niệm hoặc trò chuyện, nhưng nêu rõ khi điều đó không nằm trong cuộc họp.
- Trình bày bằng Markdown, giọng điệu gần gũi, không máy móc.`;

    // 6. Gọi Streaming
    const responseStream = await aiModel.generateContentStream(prompt);

    // 7. Intercept Stream để lưu vào DB khi hoàn tất
    const encoder = new TextEncoder();
    let fullAiResponse = "";

    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of responseStream.stream) {
            const chunkText = chunk.text();
            fullAiResponse += chunkText;
            controller.enqueue(encoder.encode(chunkText));
          }
          
          // Hoàn thành stream -> Lưu DB
          await supabase.from("meeting_chats").insert({
            meeting_id: meetingId,
            conversation_id: conversationId || null,
            role: "assistant",
            content: fullAiResponse,
          });

          controller.close();
        } catch (err) {
          console.error("[Ask AI] Stream error:", err);
          controller.error(err);
        }
      }
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (error: any) {
    console.error("[Ask AI API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
