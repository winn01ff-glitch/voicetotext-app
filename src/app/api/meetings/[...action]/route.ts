import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string[] }> }
) {
  const { action } = await params;
  
  if (!action || action.length === 0) {
    return NextResponse.json({ error: "No action provided" }, { status: 400 });
  }

  const actionPath = action.join("/");

  try {
    let handler;
    switch (actionPath) {
      case "abort":
        handler = (await import("@/lib/api/meetings/abort")).POST;
        break;
      case "ask-ai":
        handler = (await import("@/lib/api/meetings/ask-ai")).POST;
        break;
      case "cancel":
        handler = (await import("@/lib/api/meetings/cancel")).POST;
        break;
      case "rediarize":
        handler = (await import("@/lib/api/meetings/rediarize")).POST;
        break;
      case "rename-speaker":
        handler = (await import("@/lib/api/meetings/rename-speaker")).POST;
        break;
      case "resume":
        handler = (await import("@/lib/api/meetings/resume")).POST;
        break;
      case "shorten-raw":
        handler = (await import("@/lib/api/meetings/shorten-raw")).POST;
        break;
      case "reprocess/cancel-job":
        handler = (await import("@/lib/api/meetings/reprocess/cancel-job")).POST;
        break;
      case "reprocess/run-queue":
        handler = (await import("@/lib/api/meetings/reprocess/run-queue")).POST;
        break;
      default:
        return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }

    if (!handler) {
      return NextResponse.json({ error: "Handler not found" }, { status: 404 });
    }

    return await handler(request);
  } catch (error) {
    console.error(`[API] Error in meetings/${actionPath}:`, error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
