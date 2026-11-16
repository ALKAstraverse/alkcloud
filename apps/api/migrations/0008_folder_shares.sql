-- AlkCloud migration 0008 — chia sẻ được THƯ MỤC (folder share)
--
-- Bối cảnh: `shares` cũ gắn chặt với `file_id` (NOT NULL) ⇒ không thể chia sẻ
-- một thư mục. Nay dựng lại bảng cho phép đúng MỘT mục tiêu:
--   - share tệp   : file_id   khác NULL, folder_id NULL
--   - share thư mục: folder_id khác NULL, file_id NULL
--
-- CHECK constraint ⇒ không thể có share "không mục tiêu" hoặc "cả hai".
-- `ON DELETE CASCADE` giữ nguyên: xoá tệp/thư mục ⇒ share tương ứng bị xoá
-- (ngoài ra API còn chủ động revoke + audit trước khi purge).
--
-- Không có bảng nào tham chiếu `shares` ⇒ DROP/RENAME an toàn.

CREATE TABLE shares_new (
  id TEXT PRIMARY KEY,
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_params TEXT,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (file_id IS NOT NULL AND folder_id IS NULL)
    OR (file_id IS NULL AND folder_id IS NOT NULL)
  )
);

INSERT INTO shares_new (
  id, file_id, folder_id, token_hash, password_hash, password_salt, password_params,
  expires_at, max_downloads, download_count, revoked_at, created_at, updated_at
)
SELECT
  id, file_id, NULL, token_hash, password_hash, password_salt, password_params,
  expires_at, max_downloads, download_count, revoked_at, created_at, updated_at
FROM shares;

DROP TABLE shares;

ALTER TABLE shares_new RENAME TO shares;

CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_shares_folder ON shares(folder_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_file_created ON shares(file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_folder_created ON shares(folder_id, created_at DESC);
