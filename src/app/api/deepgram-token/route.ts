import { DeepgramClient } from "@deepgram/sdk";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "DEEPGRAM_API_KEY environment variable is not configured" }, { status: 500 });
    }

    const deepgram = new DeepgramClient();
    const tokenResponse = await deepgram.auth.v1.tokens.grant();
    const token = tokenResponse?.access_token;
    
    if (!token) {
      console.error("Deepgram token response has no access_token:", tokenResponse);
      return NextResponse.json({ error: "Token not found in Deepgram response" }, { status: 500 });
    }

    return NextResponse.json({ token });
  } catch (err) {
    console.error("Deepgram token exception:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
