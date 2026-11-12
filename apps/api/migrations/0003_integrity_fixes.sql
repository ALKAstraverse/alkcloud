-- AlkCloud migration 0003 — integrity fixes found trong Phase 2 audit
--
-- 1. `files.folder_id` KHÔNG được `ON DELETE CASCADE`.
--    Xoá cứng folder sẽ xoá cứng luôn file con ⇒ mất dữ liệu + mất object B2.
--    Đổi thành `ON DELETE SET NULL` (file mồ côi vẫn còn, còn trong trash để owner xử lý).
-- 2. `upload_sessions.folder_id` cũng đổi từ `ON DELETE SET NULL` — đã đúng, giữ nguyên.
-- 3. Index phục vụ truy vấn "xoá mềm theo thư mục" (batch xoá) và "khôi phục theo batch".
-- 4. `upload_sessions` cần `file_id` + `revision_id` để object key có dạng
--    `objects/{fileId}/{revisionId}` (tên file KHÔNG nằm trong key B2 — D06).
--    fileId được cấp ngay khi tạo upload session, dùng lại khi tạo file row.

-- SQLite không có ALTER CONSTRAINT ⇒ phải tạo bảng mới và copy dữ liệu.
-- Thứ tự: tạo bảng mới → copy → xoá bảng cũ → đổi tên → tạo lại index.

PRAGMA foreign_keys = OFF;

CREATE TABLE files_migrated (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL,
  etag TEXT,
  checksum_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch_id TEXT,
  purge_after TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  folder_key TEXT GENERATED ALWAYS AS (COALESCE(folder_id, '')) STORED
);

INSERT INTO files_migrated (
  id, folder_id, name, name_lower, size, content_type, object_key, revision_id, etag, checksum_sha256,
  created_at, updated_at, deleted_at, deleted_batch_id, purge_after, version
)
SELECT
  id, folder_id, name, name_lower, size, content_type, object_key, revision_id, etag, checksum_sha256,
  created_at, updated_at, deleted_at, deleted_batch_id, purge_after, version
FROM files;

DROP TABLE files;
ALTER TABLE files_migrated RENAME TO files;

CREATE UNIQUE INDEX idx_files_unique_name ON files(folder_key, name_lower) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_folder ON files(folder_id, deleted_at);
CREATE INDEX idx_files_deleted ON files(deleted_at);
CREATE INDEX idx_files_purge ON files(purge_after) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_files_name_lower ON files(name_lower);
-- Truy vấn xoá mềm / khôi phục theo batch (folder + file cùng batchId).
CREATE INDEX idx_files_batch ON files(deleted_batch_id);

ALTER TABLE upload_sessions ADD COLUMN file_id TEXT;
ALTER TABLE upload_sessions ADD COLUMN revision_id TEXT;

-- 5. Audit chain: chống fork khi 2 request đồng thời cùng đọc prev_hash.
--    `prev_hash` là PRIMARY KEY ⇒ chỉ một entry được nối vào một head.
--    Ghi audit row + head trong CÙNG một batch (atomic trên D1).
CREATE TABLE audit_chain (
  prev_hash TEXT PRIMARY KEY,
  entry_hash TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

INSERT INTO audit_chain (prev_hash, entry_hash, seq, created_at)
SELECT prev_hash, entry_hash, 1, created_at
FROM audit_logs
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- 6. Chỉ được có DUY NHẤT một owner — chặn race bootstrap 2 request đồng thời
--    với 2 email khác nhau (UNIQUE trên email không chặn được trường hợp này).
CREATE UNIQUE INDEX idx_owner_singleton ON owner((1));

PRAGMA foreign_keys = ON;
