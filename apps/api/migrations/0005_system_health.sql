-- AlkCloud migration 0005 — sức khoẻ hệ thống (WS-K)
--
-- Workers Free không có Analytics Engine và log chỉ giữ 3 ngày ⇒ cần một
-- "heartbeat" bền vững trong D1 để owner biết hệ thống còn sống mà không phải
-- đào log.
--
-- Bảng này giữ **một dòng** (key = 'heartbeat') — heartbeat của cron:
--   - lần chạy cuối + thời gian + kết quả
--   - số liệu quan trọng: usage, quota, số phiên, số upload treo
--   - trạng thái lớp lưu trữ (circuit breaker) nếu có
--
-- Ghi bằng UPSERT ⇒ không phình, không cần retention.

CREATE TABLE IF NOT EXISTS system_health (
  key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1
);

PRAGMA foreign_keys = ON;
