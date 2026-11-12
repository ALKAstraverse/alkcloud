# CHANGELOG — AlkCloud

> Ghi lại các thay đổi **có ảnh hưởng tới hành vi hoặc vận hành**.
> Mỗi mục có mã commit để tra ngược. Bằng chứng chi tiết: `docs/19-verification-ledger.md`.

---

## [Unreleased] — Phase 4 (12/11/2026)

> Trạng thái: **chưa deploy**. Mọi thay đổi dưới đây đã qua test local (347 pass / 0 fail)
> và quality gate (`verify-all.sh`: PASS=16, FAIL=0), nhưng **chưa** được kiểm chứng
> trên production. Mức độ sẵn sàng: **READY FOR OWNER APPROVAL**.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **WS-K — Observability** | Log có cấu trúc (JSON 1 dòng, redact trước khi log, catalog sự kiện cố định); heartbeat sức khoẻ trong D1 (`system_health`); `GET /system/diagnostics` (cron/degradation/storage/quota/analytics) | `docs/31` |
| **WS-L2 — Release engineering** | `npm run release:manifest` + `release:verify` — checksum từng artifact, thứ tự migration, secret checklist, kiểm tra bundle ≤ 3 MiB gzip, phát hiện artifact bị sửa | `docs/32` |
| **WS-L2/M13 — Owner onboarding CLI** | `npm run owner:onboarding` (checklist 1 lệnh + hành động kế tiếp) · `npm run owner:secrets` (sinh pepper + bootstrap token cục bộ, file mode 600) | `docs/33` |
| **WS-C — Storage integrity tooling** | `audit:storage` (quét 2 chiều DB↔B2), `reconcile:storage` (lệch), `verify:backup`, `restore:drill` (2 pha) | `docs/22`, `docs/24` |
| **WS-L — Chaos/failure harness** | 29 kịch bản hỏng (DB, B2, mạng, quota, concurrency) | `docs/24` |
| **WS-F — Product E2E** | Hành trình 14 bước + bất biến I1 (metadata⇄object), I2 (quota), I3 (audit); share không cần tài khoản; multipart > 100 MB | — |
| **WS-G — Performance benchmark** | `npm run bench` — 6 đường đo, 3 round lấy trung vị, budget nội bộ, `benchmarks/baseline.json` | `docs/27` |
| **WS-H — Cost model** | `npm run cost` — 4 kịch bản B2/Cloudflare/D1; phát hiện egress chi phối + rủi ro quota dùng chung account | `docs/28` |
| **WS-I — Frontend quality** | 31 test client (argon2 / API / upload) + static check AST W1–W7 tự suy ra 34 sink API | `docs/29` |
| **WS-J — CI** | `.github/workflows/ci.yml` — 3 job (quality 15 bước, security, build-artifacts), `permissions: contents: read`, **không deploy** | `docs/30` |
| **Migration `0004_perf_indexes.sql`** | Index `audit_chain.entry_hash` + `audit_logs.entry_hash` | `docs/27` |
| **Migration `0005_system_health.sql`** | Bảng heartbeat 1 dòng (UPSERT) | `docs/31` |

### Fixed

| Vấn đề | Mức | Mô tả | Tài liệu |
| :--- | :--- | :--- | :--- |
| **Rate limit không bao giờ chạy** | Cao | `createApp()` dựng lại mỗi request ⇒ limiter mất state. Sửa: cache app theo `env.DB` | `docs/25` §SEC-01 |
| **BUG-01 — share có mật khẩu luôn trả 400** | Trung bình | Web gửi `passwordParams: 'sha256'` (6 ký tự) < min 8. Sửa: `'sha256-v1'` | `docs/25` §BUG-01 |
| **Share bypass giới hạn tải** | Cao | Range 416 không trừ lượt tải. Sửa: `checkRange` + chỉ hoàn lượt khi lỗi server | `docs/25` §SEC-02 |
| **Hash mật khẩu share không salt/pepper** | Trung bình | Bổ sung `passwordSalt` + `passwordParams` vào hash | `docs/25` §SEC-03 |
| **Audit log không prune** | Trung bình | `pruneAuditLogs` (giữ 180 ngày, giữ `audit_chain`) | `docs/25` §SEC-04 |
| **Xoá folder vượt 50 subrequest** | Trung bình | 1 câu `WITH RECURSIVE` | `docs/25` §SEC-05 |
| **Login/recovery không giới hạn theo IP** | Trung bình | IP-only limiter + limiter theo email + `requireTrustedOrigin` | `docs/25` §SEC-06/07 |
| **`listAudit` O(n×m), không dùng index** | Trung bình | mean **5071 µs → 1047 µs** (4.8×), p95 **8443 µs → 1160 µs** | `docs/27` |
| **Lỗi B2 làm treo request** | Trung bình | `ResilientStorage`: retry có jitter + circuit breaker + `503 storage_unavailable` + `Retry-After` | `docs/26` |
| **Cron dùng thời gian thực cho dọn session** | Thấp | Dùng `scheduledTime` xuyên suốt (nhất quán, test được) | `docs/31` §3.3 |
| **Secret scanner bỏ sót file chưa track** | Trung bình | `git grep` → quét cây thư mục làm việc | `docs/31` §2 |
| **CI fail vĩnh viễn vì credential mẫu AWS** | Thấp | Test SigV4 dùng hằng thật ⇒ đổi sang hằng test | `docs/30` §3.1 |

### Security

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| SEC-01…SEC-15 | 15 phát hiện audit độc lập Phase 4, **tất cả đã xử lý** | `docs/25`, `SECURITY_AUDIT.md` §1b |
| Usage counter gộp lô | `usage_daily.api_calls` ghi 1 lần / 20 request thay vì 1 lần/request | `docs/25` §SEC-13 |
| Rate limiter có giới hạn bucket | `maxBuckets` = 10 000 + `sweepAllLimiters()` trong cron | `docs/25` §SEC-15 |
| Log phải có cấu trúc + redact | `console.log` chỉ ở module observability; mọi dòng là JSON 1 dòng | `docs/31` §2 |
| Secret scan dùng chung local + CI | 5 check (mẫu secret, file nhạy cảm, cây thư mục, giá trị secret, `.env.example`) | `docs/30` |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| Chi phí ghi D1 | Audit ghi 2 dòng/sự kiện; `audit_chain` giữ vĩnh viễn (rủi ro R-24) |
| Chất lượng mã | Test từ 189 → **347**; typecheck 0 lỗi; `npm audit` 0 vulnerabilities |
| Bundle API | gzip 165.7 KiB → **178 840 B** (trần Workers Free 3 MiB) |

### Known limitations (cần owner biết)

| # | Hạng mục | Trạng thái |
| :--- | :--- | :--- |
| B3 | Bucket B2 + 2 app key chưa có | Chặn E2E/storage thật |
| B4 | Token Cloudflare thiếu `Account Analytics: Read` | Cron không tự degrade được |
| B5 | Chưa chọn kênh alert | Cảnh báo không tới ai |
| B6 | D1 production chưa tạo (`database_id` placeholder) | Chặn migration + E2E |
| B7 | DNS `cloud.alk.xx.kg` chưa có | Web chưa truy cập được |
| — | Rate limiter in-memory không chia sẻ giữa PoP | Lớp authoritative = Cloudflare Rate Limiting Rule |
| — | Share password dùng SHA-256 phía client | Cần **cả** D1 dump **và** pepper để tấn công offline |
| — | `usage_daily.api_calls` là số xấp xỉ | Số chưa flush bị mất khi Worker tắt đột ngột |

---

## [0.1.0] — Phase 3 (12/11/2026)

- 13 phát hiện audit độc lập đã sửa (rate limit, share grant/cookie/CSRF, restore safety).
- E2E harness production (tài nguyên thật, prefix riêng, cleanup, báo cáo JSON/MD).
- Operational readiness: health check, log safety redaction, incident checklist.
- `verify-all.sh` phân biệt PASS/FAIL/SKIP/BLOCKED (SKIP **không** tính là PASS).
- Owner setup tooling: `infra/check-{b2,cloudflare-token,d1,dns,owner-prerequisites}.sh`.
- 189 test / 0 fail. Mức độ sẵn sàng: **BLOCKED** — B3/B4/B6/B7.

## [0.0.1] — Phase 1–2

- Nền tảng: Worker API + SPA web + packages `core`/`db`/`storage`/`auth`.
- Argon2id client-side, `AUTH_PEPPER` server-side, recovery code 1 lần.
- B2 private bucket, presigned PUT, multipart > 100 MB, share có/không mật khẩu.
- Degradation 4 mode + hysteresis, trash 30 ngày + purge.
- Backup D1 2 pha, restore an toàn, storage audit 2 chiều.
