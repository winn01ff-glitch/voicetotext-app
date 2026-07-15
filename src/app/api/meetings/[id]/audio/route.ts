import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// MIME type mapping based on file extensions
const MIME_TYPES: Record<string, string> = {
  webm: "audio/webm;codecs=opus",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing meeting ID" }, { status: 400 });
    }

    const audioDir = path.join(process.cwd(), "public", "audio");
    if (!fs.existsSync(audioDir)) {
      return NextResponse.json({ error: "Audio directory not found" }, { status: 404 });
    }

    // Find any file that starts with [id].
    const files = fs.readdirSync(audioDir);
    const audioFile = files.find((file) => file.startsWith(`${id}.`));

    if (!audioFile) {
      return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
    }

    const filePath = path.join(audioDir, audioFile);
    const ext = audioFile.split(".").pop()?.toLowerCase() || "";
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    const fileBuffer = fs.readFileSync(filePath);

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": fileBuffer.length.toString(),
      },
    });
  } catch (error: any) {
    console.error("[Get Audio Route Error]:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing meeting ID" }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get("audio") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const audioDir = path.join(process.cwd(), "public", "audio");
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }

    // Save with the original extension or fallback to webm
    const ext = file.name.split(".").pop() || "webm";
    const filePath = path.join(audioDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, buffer);

    console.log(`[Upload Audio Route] Saved file to server: ${filePath}`);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[Post Audio Route Error]:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
