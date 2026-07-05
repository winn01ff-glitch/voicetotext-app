-- ================================================================
-- Migration: Upload + YouTube + AI Pipeline
-- Thêm cột mới cho bảng meetings và tạo 2 bảng mới
-- ================================================================

-- === 1. Mở rộng bảng meetings ===

-- Phân loại nguồn đầu vào: 'live' (ghi âm) | 'upload' (file) | 'youtube'
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'live';

-- Link YouTube gốc (nếu có)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source_url TEXT;

-- Cache kết quả thô Deepgram (toàn bộ JSON response)
-- Dùng để debug, regenerate, đổi prompt mà KHÔNG cần gọi lại Deepgram
-- Cấu trúc: { chunks: [ {chunk_index, offset_ms, deepgram_response}, ... ] }
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS raw_deepgram_result JSONB;

-- Cache kết quả từng bước Gemini pipeline
-- Cấu trúc:
-- {
--   "chunk_count": 12,
--   "corrected_turns": [ [...chunk1], [...chunk2], ... ],
--   "speaker_mapping": [ [...chunk1], [...chunk2], ... ],
--   "merged_turns": [...],
--   "consistency_result": [...],
--   "translated_turns": [...],
--   "summary": { executive_summary, decisions },
--   "action_items": [...]
-- }
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS pipeline_results JSONB;

-- Progress chi tiết với phần trăm
-- Cấu trúc: { percent: 65, chunk_current: 3, chunk_total: 12, message: "..." }
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS progress JSONB;


-- === 2. Bảng meeting_metadata ===
-- Thông tin kỹ thuật audio — tách riêng khỏi meetings để giữ bảng chính gọn

CREATE TABLE IF NOT EXISTS meeting_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,

    -- Thông tin audio
    duration_seconds INTEGER,                        -- Thời lượng (giây)
    sample_rate INTEGER,                             -- Sample rate (Hz), vd: 44100, 16000
    channels INTEGER DEFAULT 1,                      -- Số kênh: 1 (mono), 2 (stereo)
    codec TEXT,                                      -- Codec: 'mp3', 'aac', 'opus', 'pcm'
    file_size_bytes BIGINT,                          -- Dung lượng file gốc (bytes)

    -- Thông tin nhận diện
    detected_language TEXT,                           -- Ngôn ngữ Deepgram phát hiện
    speaker_count INTEGER,                           -- Số người nói Deepgram phát hiện
    chunk_count INTEGER DEFAULT 1,                   -- Số chunk đã chia

    -- Nguồn
    created_from TEXT NOT NULL DEFAULT 'live',        -- 'live' | 'upload' | 'youtube'
    original_filename TEXT,                           -- Tên file gốc (nếu upload)
    youtube_title TEXT,                               -- Tiêu đề video YouTube
    youtube_thumbnail_url TEXT,                       -- Ảnh thumbnail YouTube

    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_metadata_meeting_id ON meeting_metadata(meeting_id);


-- === 3. Bảng pipeline_errors (Dead Letter Queue) ===
-- Lưu lỗi sau khi retry 3 lần vẫn thất bại — để debug và xử lý thủ công

CREATE TABLE IF NOT EXISTS pipeline_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,

    step TEXT NOT NULL,                              -- Bước lỗi: 'transcribing', 'correcting', 'checking'...
    chunk_index INTEGER,                             -- Chunk nào lỗi (null nếu step toàn bộ)
    attempt_count INTEGER DEFAULT 3,                 -- Số lần đã thử
    error_message TEXT,                              -- Message lỗi cuối cùng
    error_stack TEXT,                                -- Stack trace
    input_snapshot JSONB,                            -- Input của step lúc lỗi (để reproduce)
    resolved BOOLEAN DEFAULT false,                  -- Đánh dấu đã xử lý
    resolved_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_errors_meeting_id ON pipeline_errors(meeting_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_errors_unresolved ON pipeline_errors(resolved) WHERE resolved = false;


-- === 4. Thêm cột speaker_tag vào transcripts ===
-- Lưu speaker_tag trực tiếp (không chỉ speaker_id) để hỗ trợ bulk rename
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker_tag TEXT;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker_name TEXT;


-- === 5. Triggers cho bảng mới ===

CREATE OR REPLACE TRIGGER update_meeting_metadata_updated_at
    BEFORE UPDATE ON meeting_metadata
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_pipeline_errors_updated_at
    BEFORE UPDATE ON pipeline_errors
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- === 6. Enable Realtime cho meetings ===
-- Để client subscribe vào status + progress changes
-- (Chạy lệnh này trong Supabase Dashboard > Database > Replication nếu cần)
-- ALTER PUBLICATION supabase_realtime ADD TABLE meetings;
