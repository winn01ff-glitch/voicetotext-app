import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateAudioBuffer } from "@/lib/ai/audio-validator";
import { runPipeline, PipelineConfig } from "@/lib/ai/pipeline";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    // === 1. Lấy file và config từ FormData ===
    const file = formData.get("file") as File | null;
    const configStr = formData.get("config") as string | null;

    if (!file) {
      return NextResponse.json(
        { error: "Không tìm thấy file âm thanh." },
        { status: 400 }
      );
    }

    if (!configStr) {
      return NextResponse.json(
        { error: "Thiếu thông tin cấu hình cuộc họp." },
        { status: 400 }
      );
    }

    const config = JSON.parse(configStr);
    const { title, source_language, target_language, meeting_context, speakers, glossary } = config;

    if (!title || !target_language) {
      return NextResponse.json(
        { error: "Thiếu thông tin bắt buộc (title, target_language)." },
        { status: 400 }
      );
    }

    // === 2. Validate audio ===
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const validation = validateAudioBuffer(buffer, file.name, file.type);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    // === 3. Tạo meeting trong DB (status = 'queued') ===
    const supabase = await createServerSupabaseClient();

    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        title,
        status: "queued",
        source_language: source_language || "auto",
        target_language,
        meeting_context: meeting_context || "general",
        source_type: "upload",
        progress: { percent: 0, message: "Đang chờ xử lý..." },
      })
      .select()
      .single();

    if (meetingError) throw meetingError;

    const meetingId = meeting.id;

    // === 4. Tạo speakers ===
    const defaultColors = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
    if (speakers && speakers.length > 0) {
      const speakersToInsert = speakers.map((sp: any, idx: number) => ({
        meeting_id: meetingId,
        speaker_tag: sp.speaker_tag,
        display_name: sp.display_name || `Speaker ${idx}`,
        language_code: sp.language_code || "auto",
        color_hex: sp.color_hex || defaultColors[idx % defaultColors.length],
      }));

      const { error: speakersError } = await supabase
        .from("speakers")
        .insert(speakersToInsert);

      if (speakersError) throw speakersError;
    }

    // === 5. Tạo glossary ===
    if (glossary && glossary.length > 0) {
      const glossaryToInsert = glossary.map((g: any) => ({
        meeting_id: meetingId,
        source: g.source,
        target: g.target,
        source_language: g.source_language || "auto",
        target_language: g.target_language || target_language,
      }));

      const { error: glossaryError } = await supabase
        .from("glossary")
        .insert(glossaryToInsert);

      if (glossaryError) throw glossaryError;
    }

    // === 6. Tạo draft AI summary ===
    const { error: summaryError } = await supabase
      .from("ai_summaries")
      .insert({
        meeting_id: meetingId,
        status: "Draft",
        executive_summary: "",
        decisions: [],
      });

    if (summaryError) throw summaryError;

    // === 7. Tạo meeting_metadata ===
    await supabase.from("meeting_metadata").insert({
      meeting_id: meetingId,
      file_size_bytes: buffer.length,
      created_from: "upload",
      original_filename: file.name,
    });

    // === 8. Return meetingId ngay lập tức ===
    // Pipeline chạy trong background sau khi response đã gửi
    const pipelineConfig: PipelineConfig = {
      title,
      meetingContext: meeting_context || "general",
      sourceLanguage: source_language || "auto",
      targetLanguage: target_language,
      speakers: speakers || [],
      glossary: glossary || [],
    };

    after(async () => {
      try {
        await runPipeline(meetingId, buffer, pipelineConfig);
      } catch (error) {
        console.error(`[Pipeline Error] Meeting ${meetingId}:`, error);
        // runPipeline đã handle set status='failed' bên trong
      }
    });

    return NextResponse.json({
      status: "success",
      meeting_id: meetingId,
    });
  } catch (error) {
    console.error("Upload audio error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
