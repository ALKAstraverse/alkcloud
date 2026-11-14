-- AlkCloud migration 0006 — purge 2 pha (AUD-01 / AUD-02)
--
-- Vấn đề (phát hiện trong independent audit 14/11/2026):
--   1. Cron purge xoá **object B2 trước**, rồi mới xoá row D1 — và xoá row **vô điều
--      kiện** (`deleteFileRow`). Nếu owner vừa restore file trong lúc cron đang chạy
--      ⇒ file bị mất vĩnh viễn (object đã xoá) dù chỉ mới hết hạn retention.
--   2. Nếu xoá object thành công nhưng xoá row thất bại ⇒ row còn lại trỏ tới object
--      KHÔNG tồn tại ⇒ khi owner restore, file "ma" (không tải được).
--
-- Sửa: thêm trạng thái purge 2 pha trên bảng `files`:
--   NONE    — không có yêu cầu purge (mặc định, tương thích dữ liệu cũ).
--   PENDING — đã đánh dấu, **object B2 còn nguyên** ⇒ owner vẫn restore được
--              (restore sẽ huỷ purge) ⇒ không còn mất file vĩnh viễn do race.
--   PURGING — đã bắt đầu xoá object ⇒ restore bị TỪ CHỐI (409) ⇒ không tạo file "ma".
--
-- `purge_marked_at` = mốc đánh dấu PENDING (cron chỉ xoá object sau grace period).

ALTER TABLE files ADD COLUMN purge_state TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE files ADD COLUMN purge_marked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_files_purge_state ON files(purge_state, purge_after);
