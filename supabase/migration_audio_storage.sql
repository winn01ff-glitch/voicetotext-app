-- ================================================================
-- Migration: Audio Storage — Supabase Storage bucket
-- Thêm cột audio_url và RLS policies cho bucket meeting-audio
-- ================================================================

-- 1. Thêm cột audio_url vào meetings (lưu storage path, không phải URL)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS audio_url TEXT;

-- 2. RLS policies cho bucket meeting-audio
-- Bucket phải được tạo thủ công trong Supabase Dashboard trước khi chạy migration:
--   Storage → New bucket → tên: meeting-audio, Private, file size limit: 50 MB
--
-- Tạm thời cho phép anon role (chưa có auth).
-- Khi thêm Google auth: đổi TO anon → TO authenticated + thêm điều kiện user_id.

-- Cho phép upload
CREATE POLICY "meeting_audio_insert" ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'meeting-audio');

-- Cho phép đọc (signed URL vẫn cần SELECT permission)
CREATE POLICY "meeting_audio_select" ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'meeting-audio');

-- Cho phép xóa (auto-cleanup cron)
CREATE POLICY "meeting_audio_delete" ON storage.objects FOR DELETE TO anon
  USING (bucket_id = 'meeting-audio');
