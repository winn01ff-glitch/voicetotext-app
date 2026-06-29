import { DeepgramClient } from "@deepgram/sdk";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "DEEPGRAM_API_KEY environment variable is not configured" }, { status: 500 });
    }

    // Since the current API key does not have permissions to generate temporary tokens,
    // we return the key directly for local development. 
    return NextResponse.json({ token: apiKey });
  } catch (err) {
    console.error("Deepgram token exception:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
