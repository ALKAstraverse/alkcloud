-- AlkCloud migration 0004 — chỉ mục hiệu năng cho đường đọc audit
--
-- Bối cảnh: benchmark WS-G phát hiện `GET /system/audit` là đường đọc chậm
-- nhất (p95 ~8ms local) và tệ hơn khi bảng audit lớn.
--
-- Nguyên nhân gốc:
--   1. `audit_chain.entry_hash` KHÔNG có index ⇒ mỗi dòng `audit_logs` phải
--      quét toàn bộ `audit_chain` (O(n×m)).
--   2. `ORDER BY COALESCE(c.seq, -1)` là biểu thức hàm ⇒ SQLite không dùng
--      index `UNIQUE(seq)` ⇒ phải sort toàn bộ tập kết quả.
--
-- Sửa: thêm index cho cột join + viết lại query `listAudit` để DẪN ĐƯỜNG từ
-- `audit_chain` (đã có index UNIQUE(seq)) ⇒ LIMIT N chỉ đọc N dòng chain.

CREATE INDEX IF NOT EXISTS idx_audit_chain_entry ON audit_chain(entry_hash);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entry ON audit_logs(entry_hash);
