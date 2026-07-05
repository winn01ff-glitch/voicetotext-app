// Kiểu dữ liệu dùng chung cho audio validation
export interface AudioValidationResult {
  valid: boolean;
  error?: string;
  metadata?: {
    mimeType: string;
    fileSize: number;
    // Duration, sample rate, codec sẽ được đọc từ header trong pipeline
  };
}

// Danh sách MIME types hỗ trợ (bao gồm cả các định dạng video để trích xuất âm thanh)
export const SUPPORTED_AUDIO_MIMES = [
  'audio/mpeg',      // .mp3
  'audio/wav',       // .wav
  'audio/x-wav',     // .wav (alternative)
  'audio/mp4',       // .m4a
  'audio/x-m4a',     // .m4a (alternative)
  'audio/webm',      // .webm
  'audio/ogg',       // .ogg
  'audio/flac',      // .flac
  'video/mp4',       // .mp4 video
  'video/webm',      // .webm video
  'video/ogg',       // .ogg video
  'video/quicktime', // .mov video
] as const;

// Danh sách extensions hỗ trợ
export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.webm', '.ogg', '.flac', '.mp4', '.mov'
] as const;

// Giới hạn
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_DURATION_SECONDS = 4 * 60 * 60;      // 4 giờ
export const MIN_DURATION_SECONDS = 5;                  // 5 giây
export const MIN_SAMPLE_RATE = 8000;                    // 8kHz (Deepgram minimum)
export const CHUNK_DURATION_SECONDS = 10 * 60;          // 10 phút per chunk

/**
 * Validate file audio cơ bản (size + MIME type)
 * Kiểm tra nhanh trước khi xử lý — không cần decode toàn bộ file
 */
export function validateAudioFile(file: File): AudioValidationResult {
  // Kiểm tra file size
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = Math.round(file.size / (1024 * 1024));
    return {
      valid: false,
      error: `File quá lớn (${sizeMB} MB). Giới hạn tối đa là 500 MB.`,
    };
  }

  if (file.size === 0) {
    return {
      valid: false,
      error: 'File rỗng. Vui lòng chọn file âm thanh hợp lệ.',
    };
  }

  // Kiểm tra MIME type
  const mimeType = file.type.toLowerCase();
  if (!SUPPORTED_AUDIO_MIMES.includes(mimeType as any)) {
    // Fallback: kiểm tra extension
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) {
      return {
        valid: false,
        error: `Định dạng file không hỗ trợ (${mimeType || ext}). Hỗ trợ: MP3, WAV, M4A, WebM, OGG, FLAC.`,
      };
    }
  }

  return {
    valid: true,
    metadata: {
      mimeType: mimeType || 'audio/unknown',
      fileSize: file.size,
    },
  };
}

/**
 * Validate audio buffer trên server (kiểm tra chi tiết hơn)
 */
export function validateAudioBuffer(
  buffer: Buffer,
  filename: string,
  mimeType: string
): AudioValidationResult {
  // Kiểm tra file size
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    const sizeMB = Math.round(buffer.length / (1024 * 1024));
    return {
      valid: false,
      error: `File quá lớn (${sizeMB} MB). Giới hạn tối đa là 500 MB.`,
    };
  }

  if (buffer.length === 0) {
    return {
      valid: false,
      error: 'File rỗng.',
    };
  }

  // Kiểm tra magic bytes cho các format phổ biến
  const header = buffer.subarray(0, 12);

  // MP3: starts with ID3 tag or sync bytes (0xFF 0xFB/0xF3/0xF2)
  const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) || // ID3
                (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0); // Sync

  // WAV: starts with RIFF....WAVE
  const isWAV = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
                header[8] === 0x57 && header[9] === 0x41 && header[10] === 0x56 && header[11] === 0x45;

  // OGG: starts with OggS
  const isOGG = header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53;

  // FLAC: starts with fLaC
  const isFLAC = header[0] === 0x66 && header[1] === 0x4C && header[2] === 0x61 && header[3] === 0x43;

  // M4A/MP4/MOV: starts with ....ftyp or ....moov
  const isM4A = (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) || // ftyp
                (header[4] === 0x6D && header[5] === 0x6F && header[6] === 0x6F && header[7] === 0x76);   // moov

  // WebM: starts with 0x1A 0x45 0xDF 0xA3
  const isWebM = header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3;

  if (!isMP3 && !isWAV && !isOGG && !isFLAC && !isM4A && !isWebM) {
    return {
      valid: false,
      error: `File không phải âm thanh hoặc video hợp lệ. Định dạng được hỗ trợ: MP3, WAV, M4A, MP4, MOV, WebM, OGG, FLAC.`,
    };
  }

  // Detect codec from magic bytes
  let codec = 'unknown';
  if (isMP3) codec = 'mp3';
  else if (isWAV) codec = 'wav';
  else if (isOGG) codec = 'ogg';
  else if (isFLAC) codec = 'flac';
  else if (isM4A) codec = 'aac';
  else if (isWebM) codec = 'webm';

  return {
    valid: true,
    metadata: {
      mimeType: mimeType || `audio/${codec}`,
      fileSize: buffer.length,
    },
  };
}
