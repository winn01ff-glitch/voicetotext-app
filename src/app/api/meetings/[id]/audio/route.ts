import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  uploadMeetingAudio,
  getSignedAudioUrl,
} from "@/lib/supabase/supabase-storage";

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

    // 1. Kiểm tra audio_url trong DB → tạo signed URL từ Supabase Storage
    try {
      const supabase = await createServerSupabaseClient();
      const { data: meeting } = await supabase
        .from("meetings")
        .select("audio_url")
        .eq("id", id)
        .single();

      if (meeting?.audio_url) {
        const signedUrl = await getSignedAudioUrl(meeting.audio_url);
        if (signedUrl) {
          return NextResponse.redirect(signedUrl, 302);
        }
        // Signed URL thất bại → fallback sang local disk
      }
    } catch (dbErr) {
      console.warn("[Get Audio] DB/Storage lookup failed, falling back to disk:", dbErr);
    }

    // 2. Fallback: đọc file từ local disk (backward compatible)
    const audioDir = path.join(process.cwd(), "public", "audio");
    if (!fs.existsSync(audioDir)) {
      return NextResponse.json({ error: "Audio not found" }, { status: 404 });
    }

    const files = fs.readdirSync(audioDir);
    const audioFile = files.find((file) => file.startsWith(`${id}.`));

    if (!audioFile) {
      return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
    }

    const filePath = path.join(audioDir, audioFile);
    const ext = audioFile.split(".").pop()?.toLowerCase() || "";
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    const fileSize = fs.statSync(filePath).size;
    const rangeHeader = request.headers.get("range");

    // ---- HTTP Range: cho phép trình duyệt phát ngay khi tải (progressive) và tua
    // (seek) mà không cần tải hết cả file. Trả 206 Partial Content cho phần yêu cầu. ----
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const startStr = match[1];
        const endStr = match[2];
        let start = startStr ? parseInt(startStr, 10) : 0;
        let end = endStr ? parseInt(endStr, 10) : fileSize - 1;

        // Chuẩn hoá & kiểm tra biên
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= fileSize) end = fileSize - 1;
        if (start > end || start >= fileSize) {
          return new NextResponse(null, {
            status: 416, // Range Not Satisfiable
            headers: { "Content-Range": `bytes */${fileSize}`, "Accept-Ranges": "bytes" },
          });
        }

        const chunkSize = end - start + 1;
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(filePath, "r");
        try {
          fs.readSync(fd, buffer, 0, chunkSize, start);
        } finally {
          fs.closeSync(fd);
        }

        return new NextResponse(buffer, {
          status: 206,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": chunkSize.toString(),
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    // Không có Range → trả cả file, nhưng KÈM Accept-Ranges để trình duyệt biết có
    // thể tua bằng range request về sau.
    const fileBuffer = fs.readFileSync(filePath);
    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error: any) {
    console.error("[Get Audio Route Error]:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// HEAD: cho trình duyệt/logic client kiểm tra sự tồn tại + kích thước nhanh, không tải body.
export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) return new NextResponse(null, { status: 400 });

    // Kiểm tra Supabase Storage trước
    try {
      const supabase = await createServerSupabaseClient();
      const { data: meeting } = await supabase
        .from("meetings")
        .select("audio_url")
        .eq("id", id)
        .single();

      if (meeting?.audio_url) {
        // File tồn tại trên Supabase → trả 200 với content-type ước tính
        const ext = meeting.audio_url.split(".").pop()?.toLowerCase() || "webm";
        const mimeType = MIME_TYPES[ext] || "application/octet-stream";
        return new NextResponse(null, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Accept-Ranges": "bytes",
          },
        });
      }
    } catch {
      // Fallback to local disk
    }

    // Fallback: check local disk
    const audioDir = path.join(process.cwd(), "public", "audio");
    if (!fs.existsSync(audioDir)) return new NextResponse(null, { status: 404 });
    const audioFile = fs.readdirSync(audioDir).find((file) => file.startsWith(`${id}.`));
    if (!audioFile) return new NextResponse(null, { status: 404 });
    const ext = audioFile.split(".").pop()?.toLowerCase() || "";
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    const fileSize = fs.statSync(path.join(audioDir, audioFile)).size;
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return new NextResponse(null, { status: 500 });
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
    const ext = file.name.split(".").pop() || "webm";

    // 1. Luôn lưu local disk trước (safety net + backward compatible)
    const audioDir = path.join(process.cwd(), "public", "audio");
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    const filePath = path.join(audioDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, buffer);
    console.log(`[Upload Audio Route] Saved file to local disk: ${filePath}`);

    // 2. Upload lên Supabase Storage (non-blocking failure)
    let cloudUploaded = false;
    let warning: string | undefined;

    try {
      const storagePath = await uploadMeetingAudio(id, buffer, ext);

      // Lưu storage path vào DB
      const supabase = await createServerSupabaseClient();
      await supabase
        .from("meetings")
        .update({ audio_url: storagePath })
        .eq("id", id);

      cloudUploaded = true;
      console.log(`[Upload Audio Route] Uploaded to Supabase Storage: ${storagePath}`);
    } catch (uploadErr: any) {
      console.warn("[Upload Audio Route] Supabase upload failed:", uploadErr.message);
      warning = uploadErr.isQuotaError
        ? "cloud_storage_full"
        : "cloud_upload_failed";
    }

    return NextResponse.json({
      success: true,
      cloud_uploaded: cloudUploaded,
      ...(warning ? { warning } : {}),
    });
  } catch (error: any) {
    console.error("[Post Audio Route Error]:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
