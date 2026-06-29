import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, source_language, target_language, meeting_context, speakers, glossary } = body;

    if (!title || !target_language) {
      return NextResponse.json({ error: "Missing required fields (title, target_language)" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Insert meeting
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        title,
        status: "recording",
        source_language: source_language || "auto",
        target_language,
        meeting_context: meeting_context || "general",
      })
      .select()
      .single();

    if (meetingError) throw meetingError;

    const meetingId = meeting.id;

    // 2. Insert speakers
    if (speakers && speakers.length > 0) {
      // Assign random color if not provided
      const defaultColors = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6"];
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

    // 3. Insert glossary
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

    // 4. Create draft AI summary
    const { error: summaryError } = await supabase
      .from("ai_summaries")
      .insert({
        meeting_id: meetingId,
        status: "Draft",
        executive_summary: "",
        decisions: [],
      });

    if (summaryError) throw summaryError;

    return NextResponse.json({
      status: "success",
      meeting_id: meetingId,
    });
  } catch (error) {
    console.error("Start meeting error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
