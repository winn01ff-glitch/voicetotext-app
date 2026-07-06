import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const EMBEDDING_MODEL = "text-embedding-004";
const CHUNK_MAX_CHARS = 4000; // Khoảng 1000 tokens (1 token ~ 4 chars)

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not configured");
  return new GoogleGenerativeAI(apiKey);
}

export async function generateEmbeddings(meetingId: string) {
  const supabase = await createServerSupabaseClient();
  
  // 1. Fetch active transcripts
  const { data: transcripts } = await supabase
    .from("transcripts")
    .select("speaker_name, corrected_text, original_text, start_ms, end_ms")
    .eq("meeting_id", meetingId)
    .eq("is_active", true)
    .order("start_ms", { ascending: true });

  if (!transcripts || transcripts.length === 0) return;

  // 2. Gom nhóm thành chunks (~1000 tokens)
  const chunks = [];
  let currentChunkText = "";
  let currentStartMs = transcripts[0].start_ms;
  let currentEndMs = transcripts[0].end_ms;

  for (const t of transcripts) {
    const turnText = `[${t.speaker_name}]: ${t.corrected_text || t.original_text}`;
    if (currentChunkText.length + turnText.length > CHUNK_MAX_CHARS && currentChunkText.length > 0) {
      chunks.push({
        text: currentChunkText.trim(),
        start_ms: currentStartMs,
        end_ms: currentEndMs
      });
      currentChunkText = turnText + "\n";
      currentStartMs = t.start_ms;
      currentEndMs = t.end_ms;
    } else {
      currentChunkText += turnText + "\n";
      currentEndMs = t.end_ms;
    }
  }
  
  if (currentChunkText.length > 0) {
    chunks.push({
      text: currentChunkText.trim(),
      start_ms: currentStartMs,
      end_ms: currentEndMs
    });
  }

  // 3. Gọi Gemini lấy Embeddings
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  
  const embeddingsData = [];
  for (const chunk of chunks) {
    try {
      const result = await model.embedContent(chunk.text);
      const embedding = result.embedding.values;
      embeddingsData.push({
        meeting_id: meetingId,
        content: chunk.text,
        embedding: embedding,
      });
    } catch (err) {
      console.error("[RAG] Lỗi tạo embedding chunk:", err);
    }
  }

  if (embeddingsData.length === 0) return;

  // 4. Xoá bản cũ và Lưu DB
  await supabase.from("transcript_embeddings").delete().eq("meeting_id", meetingId);
  await supabase.from("transcript_embeddings").insert(embeddingsData);
  console.log(`[RAG] Đã tạo ${embeddingsData.length} chunks embedding cho meeting ${meetingId}`);
}
