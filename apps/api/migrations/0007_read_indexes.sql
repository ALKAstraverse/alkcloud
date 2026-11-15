-- AlkCloud migration 0007 — chỉ mục cho đường đọc metadata (giảm row D1 bị tính tiền)
--
-- Bối cảnh: D1 tính tiền theo **row đọc**. Mọi màn hình mặc định (list file/folder,
-- thùng rác, danh sách share, upload session đang mở) phải đi qua index theo đúng
-- thứ tự filter + sort, tránh SCAN + temp B-tree.
--
-- AlkCloud là single-owner (bảng `owner`) nên KHÔNG có cột `user_id`; "thư mục cha"
-- của file là `folder_id`, của folder là `parent_id` — index dưới đây bám đúng 2 cột đó.
-- `path` không lưu dạng chuỗi: cây được dựng bằng `parent_id`/`folder_id`.

-- List file trong 1 thư mục (sort name) — đường đọc phổ biến nhất.
-- Gồm cả `id` để keyset (name_lower, id) không phải sort lại. Index này cũng
-- phục vụ list thư mục gốc (`folder_id IS NULL`).
CREATE INDEX IF NOT EXISTS idx_files_active_folder_name
  ON files(folder_id, name_lower, id) WHERE deleted_at IS NULL;

-- List folder con (sort name).
CREATE INDEX IF NOT EXISTS idx_folders_active_parent_name
  ON folders(parent_id, name_lower) WHERE deleted_at IS NULL;

-- Tìm file theo tên: đã có idx_files_name_lower(name_lower) từ 0001.

-- Danh sách share của 1 file (sort mới nhất).
CREATE INDEX IF NOT EXISTS idx_shares_file_created
  ON shares(file_id, created_at DESC);

-- Cron/housekeeping: session OPEN cũ nhất (dọn session treo).
CREATE INDEX IF NOT EXISTS idx_upload_sessions_open_created
  ON upload_sessions(status, created_at);
