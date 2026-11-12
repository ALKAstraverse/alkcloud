-- AlkCloud migration 0001 — core domain (owner, session, folders, files, shares, uploads)
-- Target: Cloudflare D1 (SQLite). Không dùng câu lệnh không portable sang SQLite.

CREATE TABLE owner (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  auth_verifier_hash TEXT NOT NULL,
  auth_verifier_salt TEXT NOT NULL,
  auth_params TEXT NOT NULL,
  pepper_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_owner ON sessions(owner_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_recovery_owner ON recovery_codes(owner_id, used_at);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  -- parent_key: chuẩn hoá NULL (root) thành '' để unique index thực sự chặn trùng tên ở root.
  parent_key TEXT GENERATED ALWAYS AS (COALESCE(parent_id, '')) STORED
);
CREATE UNIQUE INDEX idx_folders_unique_name ON folders(parent_key, name_lower) WHERE deleted_at IS NULL;
CREATE INDEX idx_folders_parent ON folders(parent_id, deleted_at);
CREATE INDEX idx_folders_deleted ON folders(deleted_at);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
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
  -- folder_key: chuẩn hoá NULL (root) thành '' để unique index thực sự chặn trùng tên ở root.
  folder_key TEXT GENERATED ALWAYS AS (COALESCE(folder_id, '')) STORED
);
CREATE UNIQUE INDEX idx_files_unique_name ON files(folder_key, name_lower) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_folder ON files(folder_id, deleted_at);
CREATE INDEX idx_files_deleted ON files(deleted_at);
CREATE INDEX idx_files_purge ON files(purge_after) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_files_name_lower ON files(name_lower);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_params TEXT,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shares_file ON shares(file_id, revoked_at);
CREATE INDEX idx_shares_expiry ON shares(expires_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_name_lower TEXT NOT NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  uploaded_parts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, expires_at);
CREATE INDEX idx_upload_sessions_folder ON upload_sessions(folder_id, status);
