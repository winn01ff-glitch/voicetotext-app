import { DeepgramClient } from "@deepgram/sdk";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const text = searchParams.get("text");
    const voice = searchParams.get("voice") || "aura-asteria-en";

    if (!text) {
      return NextResponse.json({ error: "Missing text parameter" }, { status: 400 });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "DEEPGRAM_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const deepgram = new DeepgramClient();
    const response = await deepgram.speak.v1.audio.generate(
      {
        text,
        model: voice,
      }
    );

    const stream = response.stream;
    if (!stream) {
      throw new Error("Failed to get audio stream from Deepgram Aura");
    }

    // Return the audio stream directly to the client as audio/mpeg
    return new Response(stream as any, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    console.error("Deepgram Aura TTS error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
