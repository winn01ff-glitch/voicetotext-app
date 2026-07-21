"use client";

// Khối cấu hình "xử lý âm thanh micro" + "nhận dạng người nói".
//
// Trước đây khối này được copy-paste hai lần trong trang phòng họp (panel thường
// và panel fullscreen); sửa nhãn ở một chỗ là hai chỗ lệch nhau ngay. Gom lại
// một component để tên gọi và mô tả luôn khớp.
//
// Tên nhãn ở đây là tên CHUẨN của toàn app — modal "Cấu hình cuộc họp" ở trang
// chủ phải dùng đúng bộ chữ này, vì cả hai ghi chung một khoá localStorage.
export const AUDIO_PROCESSING_LABELS = {
  echo: "Khử tiếng vang (Echo)",
  noise: "Lọc nhiễu (Noise)",
  agc: "Tự chỉnh độ nhạy (AGC)",
} as const;

// Ba tuỳ chọn này là constraint của getUserMedia, và chỉ áp cho luồng gửi sang
// Deepgram nhận dạng trực tiếp. File ghi âm lưu lại luôn được thu bằng một luồng
// RAW riêng (xem useDeepgramLive.ts, mục "Stream RAW cho archive"), nên bật/tắt
// ở đây KHÔNG làm đổi âm thanh khi nghe lại — phải nói rõ để người dùng không
// tưởng đang chỉnh chất lượng bản ghi.
export const AUDIO_PROCESSING_NOTE =
  "Chỉ tác động lên luồng nhận dạng trực tiếp. File ghi âm luôn được lưu ở dạng thô (chưa qua xử lý) để pipeline hậu kỳ đạt độ chính xác cao nhất.";

interface AudioProcessingSettingsProps {
  disabled: boolean;
  echoCancellation: boolean;
  setEchoCancellation: (value: boolean) => void;
  noiseSuppression: boolean;
  setNoiseSuppression: (value: boolean) => void;
  autoGainControl: boolean;
  setAutoGainControl: (value: boolean) => void;
  diarizationEnabled: boolean;
  setDiarizationEnabled: (value: boolean) => void;
}

const CHECKBOX_CLASS =
  "w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

export function AudioProcessingSettings({
  disabled,
  echoCancellation,
  setEchoCancellation,
  noiseSuppression,
  setNoiseSuppression,
  autoGainControl,
  setAutoGainControl,
  diarizationEnabled,
  setDiarizationEnabled,
}: AudioProcessingSettingsProps) {
  const labelClass = disabled
    ? "text-slate-400 dark:text-slate-500"
    : "text-slate-600 dark:text-slate-350";

  const toggle = (
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    storageKey: string
  ) => (
    <div className="flex items-center justify-between text-xs py-1">
      <span className={labelClass}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          const val = e.target.checked;
          onChange(val);
          localStorage.setItem(storageKey, String(val));
        }}
        disabled={disabled}
        className={CHECKBOX_CLASS}
      />
    </div>
  );

  return (
    <>
      {/* Audio parameters toggles */}
      <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <label className="text-[10px] uppercase font-bold text-slate-400">Xử lý âm thanh micro</label>

        {toggle(AUDIO_PROCESSING_LABELS.echo, echoCancellation, setEchoCancellation, "meeting_echo_cancellation")}
        {toggle(AUDIO_PROCESSING_LABELS.noise, noiseSuppression, setNoiseSuppression, "meeting_noise_suppression")}
        {toggle(AUDIO_PROCESSING_LABELS.agc, autoGainControl, setAutoGainControl, "meeting_auto_gain_control")}

        <p className="text-[10px] text-slate-400 leading-normal">{AUDIO_PROCESSING_NOTE}</p>
      </div>

      {/* Diarization toggle */}
      <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <label className="text-[10px] uppercase font-bold text-slate-400">Nhận dạng người nói</label>

        <div className="flex items-center justify-between text-xs py-1">
          <div className="flex-1 pr-2">
            <span className={`font-medium ${labelClass}`}>Phân biệt giọng nói (Diarize)</span>
            <p className="text-[10px] text-slate-400 leading-normal mt-0.5">
              {diarizationEnabled
                ? "BẬT: Deepgram tách người nói theo sóng âm ngay khi đang họp. AI chỉ phân vai lại ở bước xử lý hậu kỳ."
                : "TẮT: Không tách người nói khi đang họp; AI phân vai 100% theo ngữ cảnh ở bước hậu kỳ."}
            </p>
          </div>
          <input
            type="checkbox"
            checked={diarizationEnabled}
            onChange={(e) => setDiarizationEnabled(e.target.checked)}
            disabled={disabled}
            className={CHECKBOX_CLASS}
          />
        </div>
      </div>
    </>
  );
}
