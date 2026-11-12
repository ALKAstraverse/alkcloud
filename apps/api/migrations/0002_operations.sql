-- AlkCloud migration 0002 — operations: audit chain, settings, quota state, idempotency, usage, quota reservation

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  severity TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX idx_audit_severity ON audit_logs(severity, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  api_calls INTEGER NOT NULL DEFAULT 0,
  uploads_started INTEGER NOT NULL DEFAULT 0,
  uploads_completed INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  share_downloads INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE quota_reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  upload_session_id TEXT,
  bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'HELD',
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX idx_quota_reservations_state ON quota_reservations(state, created_at);
CREATE UNIQUE INDEX idx_quota_reservations_session ON quota_reservations(upload_session_id) WHERE upload_session_id IS NOT NULL;
