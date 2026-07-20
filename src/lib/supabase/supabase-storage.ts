import { createServerSupabaseClient } from "./server";

const BUCKET_NAME = "meeting-audio";
const SIGNED_URL_EXPIRY_SECONDS = 86400; // 24 giờ

/**
 * Upload audio buffer vào Supabase Storage bucket `meeting-audio`.
 * Trả về storage path (e.g. "abc-123.webm") để lưu vào meetings.audio_url.
 * Throw nếu upload fail (storage đầy, network error...).
 */
export async function uploadMeetingAudio(
  meetingId: string,
  buffer: Buffer,
  extension: string = "webm"
): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const storagePath = `${meetingId}.${extension}`;

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, buffer, {
      contentType: extension === "webm" ? "audio/webm;codecs=opus" : `audio/${extension}`,
      upsert: true, // Ghi đè nếu đã tồn tại (re-upload)
    });

  if (error) {
    // Phân biệt storage đầy vs lỗi khác để caller hiển thị thông báo phù hợp
    const isQuotaError =
      error.message?.includes("quota") ||
      error.message?.includes("storage limit") ||
      error.message?.includes("413") ||
      error.message?.includes("Payload too large");

    const wrappedError = new Error(
      isQuotaError
        ? `STORAGE_QUOTA_EXCEEDED: ${error.message}`
        : `STORAGE_UPLOAD_FAILED: ${error.message}`
    );
    (wrappedError as any).isQuotaError = isQuotaError;
    throw wrappedError;
  }

  return storagePath;
}

/**
 * Tạo signed URL hết hạn sau 24 giờ cho audio đã lưu.
 * Trả về URL string hoặc null nếu file không tồn tại.
 */
export async function getSignedAudioUrl(
  storagePath: string,
  expiresIn: number = SIGNED_URL_EXPIRY_SECONDS
): Promise<string | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, expiresIn);

  if (error || !data?.signedUrl) {
    console.warn(
      `[supabase-storage] Failed to create signed URL for "${storagePath}":`,
      error?.message || "No data returned"
    );
    return null;
  }

  return data.signedUrl;
}

/**
 * Xóa audio file khỏi Supabase Storage.
 * Dùng bởi auto-cleanup cron và khi user xóa meeting.
 */
export async function deleteMeetingAudio(
  storagePath: string
): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([storagePath]);

  if (error) {
    console.error(
      `[supabase-storage] Failed to delete "${storagePath}":`,
      error.message
    );
    return false;
  }

  return true;
}

/**
 * Liệt kê tất cả audio files trong bucket (dùng cho debug/admin).
 */
export async function listMeetingAudios(): Promise<
  { name: string; created_at: string }[]
> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .list("", { limit: 1000, sortBy: { column: "created_at", order: "asc" } });

  if (error) {
    console.error("[supabase-storage] Failed to list files:", error.message);
    return [];
  }

  return (data || []).map((f) => ({
    name: f.name,
    created_at: f.created_at || "",
  }));
}
