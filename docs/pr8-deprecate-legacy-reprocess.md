# PR8 — Gộp nốt hệ thống reprocess legacy (`is_reprocessed`) vào hệ thống chính (`ai_jobs`/`version_type`)

Trạng thái: **chưa làm — cần người triển khai.** Đây là bước cuối trong chuỗi 8 PR chuẩn hóa pipeline phân vai người nói + dịch của app NOTE AIPRO. PR1-7 đã xong (xem lịch sử git gần đây / commit liên quan). PR8 là bước duy nhất có tính phá hủy (xóa code + xóa cột DB) nên tách riêng, cần review kỹ trước khi merge.

## Bối cảnh — tại sao cần làm

App có **2 hệ thống "reprocess" (AI phân tích lại toàn bộ cuộc họp) độc lập, không liên thông nhau**, cùng hiển thị trên 1 màn hình:

1. **Hệ thống chính** (giữ lại): bảng `ai_jobs` + `src/lib/ai/queueWorker.ts` + cột `transcripts.version_type` (`'RAW'|'FINAL'`) / `transcripts.version` / `transcripts.is_active`. Có retry với exponential backoff, có cancel, có progress tracking theo từng job, versioning đúng nghĩa (không xóa dữ liệu, chỉ đánh dấu `is_active=false` cho bản cũ rồi insert bản mới). Trigger: nút **"Phân tích toàn diện (Generate All)"** trên `history/[id]` → `POST /api/meetings/reprocess/run-queue`. Từ PR4, hệ thống này còn được **tự động enqueue** (job `spellcheck`/`speaker`/`translation`, không có `summary`) ngay khi kết thúc họp (`src/app/api/end-meeting/route.ts`).

2. **Hệ thống legacy** (cần loại bỏ): cột `is_reprocessed` (boolean) trên 3 bảng `transcripts`/`speakers`/`action_items`, cộng 2 cột riêng `ai_summaries.reprocessed_executive_summary`/`reprocessed_decisions`. Route: `src/app/api/reprocess-raw-transcript/route.ts`. Cơ chế: **XÓA** toàn bộ row `is_reprocessed=true` cũ rồi insert lại mới trong 1 lần gọi Gemini duy nhất (không batch, không retry, không progress). Trigger: nút **"AI Phân vai"** trên `history/[id]` (hiện đã bị ẩn sau 1 disclosure gấp gọn "Xem văn bản gốc thô / tách vai kiểu cũ" từ PR6 — xem `src/app/history/[id]/page.tsx` dòng ~3165-3171, state `showLegacyRawPanel`).

Hai hệ thống này dùng flag khác nhau (`is_reprocessed` vs `version_type`/`is_active`), lưu summary vào 2 chỗ khác nhau (`ai_summaries.reprocessed_*` vs bản ghi `ai_summaries` version-bump từ `queueWorker.ts`), và không biết đến nhau — gây rối cho cả người dùng lẫn người bảo trì code. Mục tiêu PR8: chỉ còn **1 hệ thống reprocess duy nhất**.

## Khảo sát dữ liệu hiện tại (đã kiểm tra qua Supabase MCP, 2026-07-11)

```sql
select
  (select count(*) from transcripts where is_reprocessed = true) as reprocessed_transcripts,
  (select count(distinct meeting_id) from transcripts where is_reprocessed = true) as meetings_with_reprocessed,
  (select count(*) from ai_summaries where reprocessed_executive_summary is not null and reprocessed_executive_summary != '') as summaries_with_reprocessed,
  (select count(*) from action_items where is_reprocessed = true) as reprocessed_action_items;
```
Kết quả tại thời điểm viết plan này: **tất cả đều = 0**. Nghĩa là **hiện chưa có dữ liệu thật nào dùng hệ thống legacy** trên DB production hiện tại. Điều này giảm rủi ro đáng kể — bước "migrate dữ liệu cũ" gần như không cần thiết ngay bây giờ, nhưng **vẫn phải viết script migrate phòng trường hợp có dữ liệu mới phát sinh giữa lúc viết plan này và lúc PR8 được merge** (người dùng vẫn có thể bấm nút "AI Phân vai" bất cứ lúc nào trước khi PR8 xóa nó).

⚠️ **Việc đầu tiên khi bắt tay vào PR8: chạy lại đúng query trên để xác nhận số liệu vẫn là 0 (hoặc biết chính xác có bao nhiêu meeting bị ảnh hưởng) trước khi quyết định có cần chạy script migrate hay không.**

## Các bước triển khai

### Bước 1 — Script migrate dữ liệu (idempotent, chạy trước khi xóa code)

Viết 1 script (hoặc SQL migration) làm việc sau cho **từng `meeting_id` có `is_reprocessed=true`**:

1. Nếu meeting đó **đã có** row `transcripts.version_type='FINAL'` (tức hệ thống chính đã từng chạy) → **giữ nguyên, không đụng vào**, chỉ log lại để review thủ công (tránh đè lên bản tốt hơn đã có).
2. Nếu **chưa có** `version_type='FINAL'` nào cho meeting đó:
   - Update các row `transcripts` đang có `is_reprocessed=true` → set `version_type='FINAL', version=1, is_active=true`.
   - Update các row `transcripts` khác (không phải `is_reprocessed`) của cùng meeting → set `is_active=false` (để không bị trộn với bản FINAL mới convert).
   - Tương tự cho bảng `speakers` (`is_reprocessed=true` → `version_type='FINAL', is_active=true`; các speaker khác → `is_active=false`).
   - Tương tự cho `action_items`.
   - Với `ai_summaries`: đọc `reprocessed_executive_summary`/`reprocessed_decisions` của meeting đó, insert **1 row mới** theo đúng format mà `executeSummaryJob` đang tạo (xem `src/lib/ai/queueWorker.ts` hàm `executeSummaryJob`, dòng ~347-395: cần `version` = max(version hiện có)+1, `is_active=true`, `status='Completed'`), rồi set `is_active=false` cho các row `ai_summaries` cũ của meeting đó.

Chạy script này qua Supabase MCP (`mcp__supabase__execute_sql` / `apply_migration`) hoặc qua Supabase CLI local trước, review kỹ output trước khi apply lên production.

### Bước 2 — Xóa entry point UI

File: `src/app/history/[id]/page.tsx`

- Xóa toàn bộ khối disclosure "Xem văn bản gốc thô / tách vai kiểu cũ" cùng nội dung bên trong (được PR6 bọc trong `{showLegacyRawPanel && (...)}`, tìm bằng cách grep `showLegacyRawPanel` trong file — khoảng dòng 105-107 định nghĩa state, dòng 3165-3268 là toàn bộ khối UI bao gồm nút "AI Phân vai", dropdown chọn số người nói, ô hiển thị văn bản gốc thô).
- Xóa state liên quan không còn dùng: `isReprocessingRaw`, `numSpeakers` (dòng ~176-177), hàm `handleReprocessRawTranscript` (dòng ~1159, xem toàn bộ thân hàm để xóa sạch, không để sót biến/effect phụ thuộc).
- Kiểm tra kỹ các chỗ khác trong file có đọc `isReprocessed`/`reprocessed_executive_summary`/`reprocessed_decisions`/`editedReprocessedExecSummary`/`editedReprocessedDecisions`/`handleSaveReprocessedSummary` (grep các từ khóa này) — đây là state/hàm phục vụ riêng cho việc edit bản "reprocessed" cũ, cũng nên xóa theo nếu không còn UI nào tham chiếu tới sau khi xóa panel ở trên. Cẩn thận: `reprocessedTranscripts` (không có `is`) là biến của **hệ thống chính** (`version_type==='FINAL'`, xem dòng ~774-777 file này) — **KHÔNG xóa nhầm** biến này, tên gần giống nhưng là 2 khái niệm khác nhau.

### Bước 3 — Xóa route + hàm liên quan

- Xóa file `src/app/api/reprocess-raw-transcript/route.ts`.
- Grep toàn repo `reprocess-raw-transcript` để chắc chắn không còn nơi nào gọi route này (ngoài file vừa xóa và chỗ gọi trong `history/[id]/page.tsx` đã xóa ở Bước 2).

### Bước 4 — Dọn schema DB

Cột `is_reprocessed` hiện có trên `transcripts`, `speakers`, `action_items`; cột `reprocessed_executive_summary`/`reprocessed_decisions` trên `ai_summaries`. Sau khi Bước 1-3 đã chạy ổn định **một thời gian** (khuyến nghị quan sát ít nhất vài ngày–1 tuần, không xóa cột ngay lập tức phòng khi cần rollback đọc dữ liệu cũ):

```sql
alter table transcripts drop column is_reprocessed;
alter table speakers drop column is_reprocessed;
alter table action_items drop column is_reprocessed;
alter table ai_summaries drop column reprocessed_executive_summary;
alter table ai_summaries drop column reprocessed_decisions;
```

Chạy qua `mcp__supabase__apply_migration` (không dùng `execute_sql` cho DDL, theo hướng dẫn công cụ Supabase MCP) để migration được ghi nhận đúng cách.

⚠️ **Lưu ý riêng, phát hiện trong lúc khảo sát nhưng ngoài phạm vi PR8**: các cột `ai_jobs`, `version_type`, `version`, `is_active` (trên `transcripts`/`speakers`/`action_items`/`ai_summaries`) hiện **không có trong bất kỳ file migration nào trong repo** (`supabase/schema.sql`, `supabase/migration_pipeline.sql`) — chúng được thêm trực tiếp vào DB qua dashboard, gây schema drift. Khi làm Bước 4 (đã có quyền `apply_migration`), nên tiện tay dump lại schema thật hiện tại vào 1 file migration mới trong `supabase/` để repo không còn lệch với DB production. Không bắt buộc phải làm trong cùng PR8, nhưng nên làm sớm vì càng để lâu càng khó tái tạo môi trường mới từ đầu.

## Rollback

- Bước 1 (migrate data): idempotent, review kỹ trước khi apply; giữ lại bản backup/export của các row bị update trước khi chạy (Supabase point-in-time recovery hoặc export CSV thủ công).
- Bước 2-3 (xóa code): revert commit bình thường qua git nếu phát hiện vấn đề — không mất dữ liệu vì chưa đụng DB ở bước này.
- Bước 4 (xóa cột DB): **khó rollback nhất** — nếu cần giữ đường lui, có thể đổi `DROP COLUMN` thành đổi tên cột (`RENAME COLUMN is_reprocessed TO _deprecated_is_reprocessed`) trong 1-2 tuần đầu trước khi xóa thật, thay vì xóa ngay.

## Kiểm thử sau khi làm xong

1. Chạy lại query đếm ở phần "Khảo sát dữ liệu hiện tại" — xác nhận không còn row nào `is_reprocessed=true` sót lại chưa migrate trước khi qua Bước 4.
2. `npm run lint` — không phát sinh lỗi từ việc xóa state/hàm không dùng.
3. Mở `history/[id]` của 1 vài meeting cũ (kể cả meeting từng chạy "AI Phân vai" nếu có) và meeting mới — xác nhận transcript/summary vẫn hiển thị đúng, không có ô trống bất thường, không còn nút "AI Phân vai"/panel "Hội thoại gốc" nào trong UI.
4. Bấm "Phân tích toàn diện (Generate All)" trên 1 meeting test — xác nhận vẫn chạy đúng như trước (không bị ảnh hưởng bởi việc xóa hệ thống legacy).
5. Kiểm tra Supabase Advisors (`mcp__supabase__get_advisors`) sau khi drop cột — đảm bảo không phát sinh cảnh báo mới.

## File liên quan (tham khảo nhanh)

- `src/app/api/reprocess-raw-transcript/route.ts` — xóa (Bước 3)
- `src/app/history/[id]/page.tsx` — sửa (Bước 2), các mốc dòng nêu trên có thể lệch nếu code đã đổi thêm sau khi viết plan này, luôn grep lại theo tên biến/hàm thay vì tin số dòng tuyệt đối
- `src/lib/ai/queueWorker.ts` — tham khảo format `executeSummaryJob` khi viết script migrate summary (Bước 1)
- `supabase/schema.sql`, `supabase/migration_pipeline.sql` — cần cập nhật nếu tiện tay dọn schema drift (ghi chú cuối Bước 4)
