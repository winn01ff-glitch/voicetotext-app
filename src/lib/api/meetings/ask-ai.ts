import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateEmbeddings } from "@/lib/ai/rag";
import { getGeminiClient } from "@/lib/ai/geminiClient";

const AI_MODEL = process.env.AI_QUALITY_MODEL || "gemini-2.5-pro";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768; // Khớp với cột vector(768) và RPC match_transcript_chunks

export async function POST(req: Request) {
  try {
    const { meetingId, question, history } = await req.json();

    if (!meetingId || !question) {
      return NextResponse.json({ error: "Thiếu meetingId hoặc câu hỏi" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // Lịch sử trò chuyện do client gửi lên. Chat "Hỏi AI" chỉ tồn tại ở cache trình duyệt
    // (sessionStorage), KHÔNG lưu vào database — nên không đọc/ghi bảng meeting_chats nữa.
    const validHistory = Array.isArray(history) ? history.filter((h: any) => h && h.role && h.content) : [];
    const isFirstQuestion = validHistory.length === 0;

    let historyText = "";
    if (validHistory.length > 0) {
      historyText = validHistory
        .slice(-10)
        .map((h: any) => `${String(h.role).toUpperCase()}: ${h.content}`)
        .join("\n");
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

    const genAI = getGeminiClient();
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

    const prompt = `Bạn là trợ lý AI chuyên phân tích nội dung cuộc họp. Nhiệm vụ DUY NHẤT của bạn là giúp người dùng hiểu, khai thác và tìm kiếm thông tin từ cuộc họp này.

LỊCH SỬ TRÒ CHUYỆN:
${historyText}

NGỮ CẢNH CUỘC HỌP (trích từ bản ghi):
${contextText}

CÂU HỎI MỚI: ${question}

QUY TẮC BẮT BUỘC:
1. **PHẠM VI NGHIÊM NGẶT (Tán gẫu, câu hỏi ngoài lề)**: Mọi yêu cầu KHÔNG liên quan đến cuộc họp (tán gẫu, trò chuyện phiếm, kể chuyện, viết code, v.v.) phải được TỪ CHỐI một cách hài hước, nhẹ nhàng.
   - Khi từ chối, ở cuối phần câu trả lời chính (trước tag '[SUGGESTIONS]'), hãy luôn viết một câu đề xuất tự nhiên và sáng tạo để điều hướng người dùng quay lại chủ đề cuộc họp.
   - **BẮT BUỘC THAY ĐỔI CÁCH DIỄN ĐẠT**: Tuyệt đối không được sao chép nguyên văn câu ví dụ, hãy tự động sáng tạo ra các câu khác nhau dựa trên ngữ cảnh để tránh lặp lại máy móc qua các lượt chat. 
   - Ví dụ các kiểu diễn đạt đa dạng:
     + "Cơ mà thôi, tám chuyện ngoài lề thế đủ rồi, quay lại 'chuyên môn' cuộc họp tí đi bạn ơi! Mình có vài câu hỏi 'cực chất' ở bên dưới cho bạn nè: 😄"
     + "Nói vui vậy thôi chứ nhiệm vụ chính của mình là hỗ trợ bạn hiểu cuộc họp này mà. Bạn có muốn chém gió tiếp về tài liệu cuộc họp qua mấy câu hỏi này không? 👇"
     + "Nhưng mà này, 'đi chơi' hơi xa rồi đó nha, quay lại phi thuyền an toàn lao động thôi nào! Bạn thử ngó qua mấy câu hỏi gợi ý siêu xịn dưới đây xem sao: 🚀"
     + "Đùa chút thôi, buôn dưa lê thế là đủ rồi, giờ mình tập trung vào cuộc họp nhé! Mình gợi ý vài câu hỏi bên dưới cho bạn nè:"
   - Vẫn BẮT BUỘC đưa ra gợi ý câu hỏi liên quan đến cuộc họp sau tag '[SUGGESTIONS]'.
2. **GIỌNG ĐIỆU**: Thân thiện, hài hước, gần gũi — nhưng luôn xoay quanh cuộc họp.
3. **CHÀO HỎI VÀ MỞ ĐẦU**:
   - ${isFirstQuestion ? "Hãy chào hỏi niềm nở ở câu trả lời đầu tiên này (ví dụ: Chào bạn! Rất vui được hỗ trợ...). Nếu người dùng chỉ chào hỏi, đáp lại niềm nở rồi gợi ý vài câu hỏi hay về cuộc họp." : "Đây là câu hỏi tiếp theo trong đoạn chat. NGHIÊM CẤM chào hỏi lại, KHÔNG viết các câu như 'Chào bạn', 'Chào bạn trở lại', 'Rất vui được tiếp tục hỗ trợ...', v.v. Hãy đi thẳng vào trả lời trực tiếp và ngắn gọn câu hỏi mới của người dùng."}
4. **TRUNG THỰC**: Dựa vào NGỮ CẢNH ở trên để trả lời. KHÔNG bịa chi tiết (số liệu, tên, quyết định) không có trong ngữ cảnh. Nếu không tìm thấy thông tin, nói thật.
5. **LÀM RÕ**: Nếu câu hỏi mơ hồ, chủ động hỏi lại để hiểu rõ ý người dùng.
6. **NGÔN NGỮ**: Trả lời bằng ngôn ngữ của người dùng, trình bày bằng Markdown.
7. **KẾT BÀI VÀ GỢI Ý CÂU HỎI**:
   - Đối với câu hỏi về cuộc họp: Ở cuối phần câu trả lời chính (trước tag '[SUGGESTIONS]'), hãy luôn viết 1 câu kết luận ngắn gọn, tự nhiên và chuyên nghiệp để đúc kết lại nội dung trả lời (Tuyệt đối KHÔNG viết thêm các câu đề xuất câu hỏi gợi ý dạng dẫn dắt như "Nhưng mà này...", "Mình có vài câu hỏi...").
   - Đối với câu hỏi ngoài lề/tán gẫu: Viết câu từ chối kèm câu đề xuất điều hướng tự nhiên và sáng tạo (biến tấu từ ngữ liên tục ở mỗi lượt trả lời để không bị lặp lại máy móc) như quy định ở Quy tắc 1.
   - BẮT BUỘC phân tách phần câu trả lời chính (gồm câu kết tương ứng) và phần gợi ý câu hỏi bằng dòng chữ duy nhất: '[SUGGESTIONS]'.
   - Ngay sau dòng '[SUGGESTIONS]', hãy viết trực tiếp các câu hỏi gợi ý dạng in đậm kèm dấu hỏi: **câu hỏi gợi ý?** mà không có bất kỳ lời dẫn nhập nào khác giữa dòng '[SUGGESTIONS]' và các câu hỏi.`;


    // 6. Gọi Streaming
    const responseStream = await aiModel.generateContentStream(prompt);

    // 7. Stream câu trả lời về client. Không lưu DB — chat chỉ tồn tại ở cache trình duyệt.
    const encoder = new TextEncoder();

    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of responseStream.stream) {
            controller.enqueue(encoder.encode(chunk.text()));
          }
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
