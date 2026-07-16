import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PipelineConfig } from "@/lib/ai/pipeline";
import { runYoutubePipeline } from "@/lib/ai/youtubePipeline";

/**
 * Xử lý YouTube URL
 * Tạo meeting → return meetingId → after() tải audio + chạy pipeline
 * (logic tải + xử lý nằm ở lib/ai/youtubePipeline.ts — dùng chung với route resume)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { youtube_url, title, source_language, target_language, meeting_context, speakers, glossary } = body;

    if (!youtube_url) {
      return NextResponse.json(
        { error: "Thiếu đường dẫn YouTube." },
        { status: 400 }
      );
    }

    if (!target_language) {
      return NextResponse.json(
        { error: "Thiếu ngôn ngữ dịch đích." },
        { status: 400 }
      );
    }

    // Validate YouTube URL
    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/;
    if (!ytRegex.test(youtube_url)) {
      return NextResponse.json(
        { error: "Đường dẫn YouTube không hợp lệ." },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();

    // Tạo meeting (status = queued)
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        title: title || "YouTube Video",
        status: "queued",
        source_language: source_language || "auto",
        target_language,
        meeting_context: meeting_context || "general",
        source_type: "youtube",
        source_url: youtube_url,
        progress: { percent: 0, message: "Đang chờ xử lý..." },
      })
      .select()
      .single();

    if (meetingError) throw meetingError;

    const meetingId = meeting.id;

    // Tạo speakers
    const defaultColors = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
    if (speakers && speakers.length > 0) {
      const speakersToInsert = speakers.map((sp: any, idx: number) => ({
        meeting_id: meetingId,
        speaker_tag: sp.speaker_tag,
        display_name: sp.display_name || `Speaker ${idx}`,
        language_code: sp.language_code || "auto",
        color_hex: sp.color_hex || defaultColors[idx % defaultColors.length],
      }));

      await supabase.from("speakers").insert(speakersToInsert);
    }

    // Tạo glossary
    if (glossary && glossary.length > 0) {
      const glossaryToInsert = glossary.map((g: any) => ({
        meeting_id: meetingId,
        source: g.source,
        target: g.target,
        source_language: g.source_language || "auto",
        target_language: g.target_language || target_language,
      }));

      await supabase.from("glossary").insert(glossaryToInsert);
    }

    // Tạo draft AI summary
    await supabase.from("ai_summaries").insert({
      meeting_id: meetingId,
      status: "Draft",
      executive_summary: "",
      decisions: [],
    });

    // Tạo meeting_metadata
    await supabase.from("meeting_metadata").insert({
      meeting_id: meetingId,
      created_from: "youtube",
    });

    // Pipeline config
    const pipelineConfig: PipelineConfig = {
      title: title || "YouTube Video",
      meetingContext: meeting_context || "general",
      sourceLanguage: source_language || "auto",
      targetLanguage: target_language,
      speakers: speakers || [],
      glossary: glossary || [],
    };

    // Background: tải audio từ YouTube rồi chạy pipeline (tự xử lý lỗi bên trong)
    after(() => runYoutubePipeline(meetingId, youtube_url, pipelineConfig, title || null));

    return NextResponse.json({
      status: "success",
      meeting_id: meetingId,
    });
  } catch (error) {
    console.error("Process YouTube error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
