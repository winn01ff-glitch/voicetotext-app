import { GoogleGenerativeAI } from "@google/generative-ai";

let currentKeyIndex = 0;
const blockedKeys = new Map<string, number>(); // key -> blockedUntil timestamp

const MINUTE_BLOCK_MS = 60_000;

/**
 * Số ms còn lại đến nửa đêm giờ Pacific — thời điểm Google reset quota
 * requests-per-day (theo docs Gemini API rate limits).
 *
 * Tính "đã trôi qua bao nhiêu giây trong ngày theo giờ Pacific" rồi lấy phần
 * còn lại, nên tự đúng với cả PST lẫn PDT mà không cần biết đang mùa nào.
 * Hai ngày chuyển DST mỗi năm dài 23h/25h nên lệch tối đa 1 tiếng — chấp nhận
 * được vì hệ quả chỉ là mở khoá sớm/muộn một nhịp.
 */
export function msUntilPacificMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // hour12:false trả "24" cho nửa đêm ở một số môi trường.
  const hour = get("hour") % 24;
  const elapsedSec = hour * 3600 + get("minute") * 60 + get("second");
  const remainingSec = 24 * 3600 - elapsedSec;
  // Tối thiểu 1 phút: đúng nửa đêm mà trả 0 thì key mở khoá ngay rồi 429 lại.
  return Math.max(remainingSec * 1000, MINUTE_BLOCK_MS);
}

/**
 * Lỗi 429 này là hết quota NGÀY hay chỉ quá tải theo PHÚT?
 *
 * Google trả chi tiết QuotaFailure kèm quotaId dạng
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier", và thông điệp dạng
 * "quota metric ... per day". Docs không cam kết định dạng này nên đây là
 * heuristic: KHÔNG nhận ra thì mặc định coi là lỗi theo phút (chặn 60s, đúng
 * hành vi cũ). Nhận nhầm phút thành ngày sẽ khoá key vô cớ hàng giờ, nên chỉ
 * bắt các mẫu đặc trưng của quota ngày.
 */
function isDailyQuotaError(error: unknown): boolean {
  const raw = typeof error === "string" ? error : String((error as any)?.message ?? error ?? "");
  const normalized = raw.toLowerCase().replace(/[\s_-]/g, "");
  return (
    normalized.includes("perday") ||
    normalized.includes("requestsperday") ||
    normalized.includes("dailylimit") ||
    normalized.includes("dailyquota")
  );
}

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

export function markKeyBlocked(apiKey: string, durationMs: number = MINUTE_BLOCK_MS) {
  const until = Date.now() + durationMs;
  // Không rút ngắn lệnh chặn đang có: quota ngày (dài) không được ghi đè bởi
  // một lỗi theo phút đến sau.
  const current = blockedKeys.get(apiKey) || 0;
  blockedKeys.set(apiKey, Math.max(current, until));
}

/** Còn key nào dùng được ngay bây giờ không. */
function hasAvailableKey(keys: string[]): boolean {
  const now = Date.now();
  return keys.some((k) => now >= (blockedKeys.get(k) || 0));
}

export async function runWithGeminiClient<T>(
  fn: (client: GoogleGenerativeAI) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  const keys = getApiKeys();
  const attempts = Math.min(maxRetries, Math.max(keys.length, 3));

  let lastError: any = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Mọi key đều đang bị chặn → thử tiếp chỉ tốn thêm request lỗi. Dừng ngay
    // để caller fail-soft, thay vì nướng hết lượt retry vào việc chắc chắn hỏng.
    if (attempt > 0 && !hasAvailableKey(keys)) {
      break;
    }

    const apiKey = getBestApiKey();
    const client = new GoogleGenerativeAI(apiKey);
    try {
      return await fn(client);
    } catch (err: any) {
      console.warn(`Gemini call failed (attempt ${attempt + 1}/${attempts}) with key ending in ...${apiKey.slice(-5)}:`, err);
      const errorStr = String(err).toLowerCase();

      if (errorStr.includes("429") || errorStr.includes("quota exceeded") || errorStr.includes("too many requests")) {
        // Hết quota NGÀY thì chặn 1 phút là vô nghĩa: phút sau thử lại vẫn 429,
        // lặp suốt ngày và đốt quota của key khác theo. Chặn tới lúc Google
        // thực sự reset (nửa đêm giờ Pacific).
        if (isDailyQuotaError(err)) {
          const blockMs = msUntilPacificMidnight();
          markKeyBlocked(apiKey, blockMs);
          console.warn(
            `[Gemini] Key ...${apiKey.slice(-5)} hết quota NGÀY — tạm ngưng ${(blockMs / 3_600_000).toFixed(1)}h tới nửa đêm giờ Pacific.`
          );
        } else {
          markKeyBlocked(apiKey, MINUTE_BLOCK_MS);
        }
      }

      lastError = err;
      if (keys.length <= 1) {
        break;
      }
    }
  }
  throw lastError || new Error("All Gemini API keys failed");
}
