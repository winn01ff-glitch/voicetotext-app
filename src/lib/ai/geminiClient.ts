import { GoogleGenerativeAI } from "@google/generative-ai";

let currentKeyIndex = 0;
const blockedKeys = new Map<string, number>(); // key -> blockedUntil timestamp

function getApiKeys(): string[] {
  const keys: string[] = [];
  
  // 1. Check GEMINI_API_KEY (could be a comma-separated list of keys)
  if (process.env.GEMINI_API_KEY) {
    const splitKeys = process.env.GEMINI_API_KEY.split(",")
      .map(k => k.trim())
      .filter(k => k.length > 0);
    keys.push(...splitKeys);
  }
  
  // 2. Check numbered keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key && key.trim()) {
      const trimmed = key.trim();
      if (!keys.includes(trimmed)) {
        keys.push(trimmed);
      }
    }
  }
  
  return keys;
}

export function getBestApiKey(): string {
  const allKeys = getApiKeys();
  if (allKeys.length === 0) {
    throw new Error("No GEMINI_API_KEY environment variables are configured.");
  }
  
  const now = Date.now();
  // Filter out keys that are currently blocked
  const availableKeys = allKeys.filter(k => {
    const blockedUntil = blockedKeys.get(k) || 0;
    return now >= blockedUntil;
  });
  
  if (availableKeys.length > 0) {
    currentKeyIndex = (currentKeyIndex + 1) % availableKeys.length;
    return availableKeys[currentKeyIndex];
  }
  
  // If all keys are blocked, pick the one that will unblock the earliest
  let earliestUnblockKey = allKeys[0];
  let minTime = blockedKeys.get(allKeys[0]) || 0;
  for (const k of allKeys) {
    const time = blockedKeys.get(k) || 0;
    if (time < minTime) {
      minTime = time;
      earliestUnblockKey = k;
    }
  }
  return earliestUnblockKey;
}

export function getGeminiClient(): GoogleGenerativeAI {
  return new GoogleGenerativeAI(getBestApiKey());
}

export function markKeyBlocked(apiKey: string, durationMs: number = 60000) {
  blockedKeys.set(apiKey, Date.now() + durationMs);
}

export async function runWithGeminiClient<T>(
  fn: (client: GoogleGenerativeAI) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  const keys = getApiKeys();
  const attempts = Math.min(maxRetries, Math.max(keys.length, 3));
  
  let lastError: any = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const apiKey = getBestApiKey();
    const client = new GoogleGenerativeAI(apiKey);
    try {
      return await fn(client);
    } catch (err: any) {
      console.warn(`Gemini call failed (attempt ${attempt + 1}/${attempts}) with key ending in ...${apiKey.slice(-5)}:`, err);
      const errorStr = String(err).toLowerCase();
      
      if (errorStr.includes("429") || errorStr.includes("quota exceeded") || errorStr.includes("too many requests")) {
        markKeyBlocked(apiKey, 60000); // block key for 1 minute
      }
      
      lastError = err;
      if (keys.length <= 1) {
        break;
      }
    }
  }
  throw lastError || new Error("All Gemini API keys failed");
}
