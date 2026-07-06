import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return NextResponse.json({ error: "Thiếu jobId" }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    
    // Set status to cancelled
    const { error } = await supabase
      .from("ai_jobs")
      .update({ status: "cancelled", progress: 0 })
      .eq("id", jobId);

    if (error) {
      console.error("[Cancel Job] Error:", error);
      return NextResponse.json({ error: "Không thể huỷ tác vụ" }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: "Đã huỷ tác vụ thành công" });
  } catch (error: any) {
    console.error("[Cancel Job API] Lỗi:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ" }, { status: 500 });
  }
}
