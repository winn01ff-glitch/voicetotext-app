const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://cxjorywgtvwpsmhgxcar.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const geminiApiKey = process.env.GEMINI_API_KEY || "";

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(geminiApiKey || "DUMMY_KEY");

async function run() {
  const meetingId = "e89c6bca-2c83-4ef0-add2-a60b155f315d";

  // 1. Fetch raw transcripts that do not have translated_text yet
  const { data: rawTranscripts, error: txError } = await supabase
    .from("transcripts")
    .select("id, original_text, corrected_text, translated_text, version_type")
    .eq("meeting_id", meetingId)
    .or("version_type.eq.RAW,version_type.eq.raw")
    .order("start_ms", { ascending: true });

  if (txError) {
    console.error(txError);
    return;
  }

  // Filter out any that already have translations
  const pending = rawTranscripts.filter(t => !t.translated_text);
  console.log(`Total RAW: ${rawTranscripts.length}, Pending translation: ${pending.length}`);

  if (pending.length === 0) {
    console.log("All translated!");
    return;
  }

  // We chunk in small batches of 10 for absolute reliability
  const BATCH_SIZE = 10;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const inputData = batch.map((t, idx) => ({
      index: idx + 1,
      text: t.corrected_text || t.original_text || "",
    }));

    console.log(`Translating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)} (size: ${batch.length})...`);

    const prompt = `
Bạn là chuyên gia dịch thuật. Hãy dịch danh sách các lượt thoại sau từ tiếng Nhật sang tiếng Việt.
Đầu vào là định dạng JSON gồm danh sách các phần tử có index và text.
Đầu ra phải là định dạng JSON khớp chính xác 100% về số lượng và thứ tự phần tử, chỉ dịch nội dung trong text sang tiếng Việt.

ĐẦU VÀO:
${JSON.stringify(inputData)}

OUTPUT FORMAT (JSON ONLY, NO MARKDOWN):
{
  "translated_turns": [
    {
      "index": 1,
      "text": "bản dịch tiếng Việt"
    }
  ]
}
`;

    const modelName = "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
    
    try {
      const response = await model.generateContent(prompt);
      const resultText = response.response.text();
      
      const cleanJson = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleanJson);
      const translatedTurns = parsed.translated_turns;

      if (!translatedTurns || translatedTurns.length !== batch.length) {
        throw new Error(`Length mismatch: expected ${batch.length}, got ${translatedTurns?.length}`);
      }

      // Update database
      const updates = batch.map((t, idx) => {
        const transText = translatedTurns[idx].text;
        return supabase
          .from("transcripts")
          .update({ translated_text: transText })
          .eq("id", t.id);
      });
      await Promise.all(updates);
      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} updated successfully.`);
    } catch (e) {
      console.error(`Failed to translate batch starting at index ${i}:`, e.message);
      // Fallback: translate one by one for this batch
      for (const t of batch) {
        try {
          console.log(`Fallback: Translating single turn ${t.id}...`);
          const singlePrompt = `Dịch câu này từ tiếng Nhật sang tiếng Việt. Trả về kết quả là chuỗi dịch duy nhất, không thêm bớt từ nào khác:\n"${t.corrected_text || t.original_text}"`;
          const singleModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const singleResponse = await singleModel.generateContent(singlePrompt);
          const transText = singleResponse.response.text().trim().replace(/^"|"$/g, "");
          
          await supabase
            .from("transcripts")
            .update({ translated_text: transText })
            .eq("id", t.id);
          console.log(`Single turn ${t.id} translated.`);
        } catch (singleErr) {
          console.error(`Single turn translation failed for ${t.id}:`, singleErr.message);
        }
      }
    }
  }

  console.log("Translation process finished!");
}

run();
