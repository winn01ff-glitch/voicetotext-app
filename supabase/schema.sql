-- Enable pg_trgm extension for multi-lingual search (Vietnamese, Japanese, English)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Bảng lưu trữ thông tin cuộc họp chính
CREATE TABLE IF NOT EXISTS meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    status TEXT DEFAULT 'recording' NOT NULL, -- 'recording', 'processing', 'completed', 'failed'
    duration_ms INTEGER DEFAULT 0, -- Tổng thời lượng cuộc họp
    source_language TEXT DEFAULT 'auto' NOT NULL, -- Ngôn ngữ gốc mặc định ('auto', 'vi', 'en', 'ja')
    target_language TEXT NOT NULL, -- Ngôn ngữ dịch đích của cuộc họp
    meeting_context TEXT DEFAULT 'general' NOT NULL, -- Ngữ cảnh cuộc họp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_pinned BOOLEAN DEFAULT false,
    is_favorite BOOLEAN DEFAULT false,
    raw_transcript TEXT
);

-- Bảng quản lý người phát biểu trong từng cuộc họp
CREATE TABLE IF NOT EXISTS speakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,
    speaker_tag TEXT NOT NULL, -- Nhãn nhận dạng từ Deepgram (ví dụ: "speaker_0", "speaker_1")
    display_name TEXT NOT NULL, -- Tên hiển thị cấu hình (ví dụ: "Anh Hùng", "Tanaka-san")
    language_code TEXT DEFAULT 'auto', -- Ngôn ngữ mặc định
    color_hex TEXT NOT NULL, -- Mã màu sắc pastel gán ngẫu nhiên
    is_reprocessed BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(meeting_id, speaker_tag)
);

-- Bảng từ điển tên riêng/thuật ngữ chuyên ngành dùng riêng cho mỗi cuộc họp
CREATE TABLE IF NOT EXISTS glossary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,
    source TEXT NOT NULL, -- Từ gốc (ví dụ: "NG")
    target TEXT NOT NULL, -- Từ dịch chuẩn (ví dụ: "不良")
    source_language VARCHAR(10) NOT NULL, -- Ngôn ngữ nguồn (ví dụ: "en")
    target_language VARCHAR(10) NOT NULL, -- Ngôn ngữ dịch đích (ví dụ: "ja")
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Bảng lưu trữ chi tiết từng câu hội thoại
CREATE TABLE IF NOT EXISTS transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,
    speaker_id UUID REFERENCES speakers(id) ON DELETE SET NULL,
    original_text TEXT NOT NULL,
    corrected_text TEXT, -- Text sau khi được AI sửa lỗi
    translated_text TEXT, -- Text dịch bởi AI
    translation_language TEXT,
    translation_provider TEXT DEFAULT 'Gemini', -- Engine dịch
    is_edited BOOLEAN DEFAULT false,
    edited_text TEXT,
    start_ms INTEGER NOT NULL, -- Thời điểm bắt đầu câu (mili-giây từ lúc họp)
    end_ms INTEGER NOT NULL, -- Thời điểm kết thúc câu (mili-giây từ lúc họp)
    confidence REAL, -- Điểm tin cậy từ Deepgram
    is_reprocessed BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Bảng lưu tóm tắt cuộc họp
CREATE TABLE IF NOT EXISTS ai_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE UNIQUE NOT NULL,
    status TEXT DEFAULT 'Draft' NOT NULL, -- 'Draft', 'Generating', 'Completed'
    executive_summary TEXT,
    decisions TEXT[],
    reprocessed_executive_summary TEXT,
    reprocessed_decisions TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Bảng quản lý Action Items
CREATE TABLE IF NOT EXISTS action_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,
    description TEXT NOT NULL,
    owner TEXT,
    deadline TIMESTAMP WITH TIME ZONE, -- Hạn chót dạng timestamp (NULL nếu AI không chắc chắn)
    is_completed BOOLEAN DEFAULT false,
    is_reprocessed BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Bảng lưu trữ tệp đính kèm
CREATE TABLE IF NOT EXISTS attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE NOT NULL,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT NOT NULL, -- 'docx', 'pdf', 'txt', 'markdown', 'json'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Tạo Index pg_trgm hỗ trợ tìm kiếm ILIKE tốc độ cao cho tiếng Việt, Nhật, Anh
CREATE INDEX IF NOT EXISTS idx_transcripts_original_trgm ON transcripts USING gin (original_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transcripts_translated_trgm ON transcripts USING gin (translated_text gin_trgm_ops);

-- Triggers to automatically update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_meetings_updated_at
    BEFORE UPDATE ON meetings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_speakers_updated_at
    BEFORE UPDATE ON speakers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_glossary_updated_at
    BEFORE UPDATE ON glossary
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_transcripts_updated_at
    BEFORE UPDATE ON transcripts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ai_summaries_updated_at
    BEFORE UPDATE ON ai_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_action_items_updated_at
    BEFORE UPDATE ON action_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_attachments_updated_at
    BEFORE UPDATE ON attachments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
