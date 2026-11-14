# CHANGELOG — AlkCloud

> Ghi lại các thay đổi **có ảnh hưởng tới hành vi hoặc vận hành**.
> Mỗi mục có mã commit để tra ngược. Bằng chứng chi tiết: `docs/19-verification-ledger.md`.

---

## [Unreleased] — Phase 7 (14/11/2026) — DEPLOY WEB (REDESIGN UI/UX)

> Trạng thái: **WEB ĐÃ DEPLOY PRODUCTION**. Worker `alkcloud-web` version `65372961-34f3-4af0-a9ad-3987c520b7e1` (14/11 15:00 UTC — Phase 7.2);
> `/` → 307 → `/app/FvyLZVnF/`; E2E production `PASS=21 · FAIL=0`; `check-production-health` PASS.
> Bằng chứng: `docs/34-PRODUCTION-DEPLOYMENT-REPORT.md` §14–§17 · `docs/42-UI-UX-REDESIGN.md` · `docs/44-VISUAL-QA-REPORT.md`.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Redesign UI/UX toàn diện** | Design system (token light/dark, typography, component, breakpoint), file manager mới (grid/list, multi-select + bulk bar, sort, breadcrumb, drag&drop, upload queue tuần tự), trang Thùng rác, trang Cài đặt 4 mục, login 3 chế độ + recovery codes | `docs/42`, `docs/43` |
| **Danh sách kiểu Google Drive / Nextcloud (P7.2)** | Bảng cột Tên / Sửa đổi / Kích thước (mặc định list), sort bằng click tiêu đề cột + đảo chiều, menu chuột phải (`ContextMenu.tsx`), click = chọn / bấm đúp = mở / Enter = mở, bộ đếm "N thư mục · M tệp", meta gộp cho mobile | `docs/42` §7, `docs/34` §16c |
| **Font tự host** | Inter (SIL OFL 1.1) — 3 file `woff2` + `OFL.txt`; không gọi font bên thứ ba | `docs/43` |
| **Helper KDF cho script Node** | `scripts/lib/auth-key.ts` — PBKDF2 theo `params` server trả (fallback Argon2id cho tài khoản cũ) | `docs/34` §16 |

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-15 | `infra/check-production-health.sh` fail vì kỳ vọng `/` trả 200 trong khi entry point có version trả 307 | Trung bình |
| BUG-16 | Script E2E/verify-auth/verify-monitoring hard-code Argon2id ⇒ không chạy được sau khi server chuyển KDF sang PBKDF2 | Cao |
| BUG-17 | `scripts/bootstrap-owner.ts` tạo owner bằng Argon2id ⇒ tài khoản mới không đăng nhập được | Cao |
| BUG-18 | `__BUILD_ID__` bị tree-shake ⇒ mất cơ chế đối chiếu bundle theo runbook | Thấp |
| BUG-19 | `npm run bench` fail `POST /uploads → 429`: benchmark tạo 200 session upload rồi mới huỷ, vượt `MAX_OPEN_UPLOAD_SESSIONS = 50` (guard Phase 6) | Trung bình |
| BUG-20 | Upload chậm: dữ liệu đi qua 2 Worker hop (API → relay → B2) + 3 lượt gọi API tuần tự mỗi file | Trung bình |
| BUG-21 | Upload trùng tên báo "Thất bại" (409) dù file đã có trong thư mục; session `OPEN` bị rò quota | Cao |
| BUG-22 | Hàng đợi upload chạy tuần tự ⇒ nhiều file rất chậm | Thấp |

### Changed

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Bundle web** | P7.2: `index-FvyLZVnF.js` 362.55 kB (gzip **110.96 kB**), `index-CD7g8GN7.css` 55.30 kB (gzip 10.19 kB), `react-DbHEDQBy.js` 11.72 kB | `docs/14` §1 |

---

## [Unreleased] — Phase 5 (13/11/2026) — DEPLOY PRODUCTION

> Trạng thái: **PRODUCTION VERIFIED**. API + relay + Web + D1 + DNS + owner + cron + B2 đã chạy thật;
> E2E `PASS=21 · FAIL=0 · SKIP=0 · BLOCKED=0`, `verify-all` `PASS=24 · FAIL=0 · SKIP=0 · BLOCKED=0`.
> Bằng chứng: `docs/34-PRODUCTION-DEPLOYMENT-REPORT.md` · `docs/35-PRODUCTION-VERIFICATION.md`.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Production deploy** | Worker `alkcloud-api` (route `api.alk.xx.kg/api/v1/*`), Worker `alkcloud-web` (`cloud.alk.xx.kg`), D1 `alkcloud` (16 bảng, migration 0001…0005), CNAME `cloud` (proxied) | `docs/34` §2 |
| **Owner bootstrap CLI** | `scripts/bootstrap-owner.ts` — Argon2id, idempotent, lưu 10 recovery code mode 600 | `docs/35` §3 |
| **Xác minh production** | `scripts/verify-auth-production.ts` (13 kiểm tra), `scripts/verify-monitoring-production.ts`, `scripts/run-e2e-production.ts` (wrapper E2E, tự tính authKey) | `docs/35` |
| **Loader token theo nhãn** | `infra/lib/cf-token.sh` — nạp token Cloudflare theo label (`Edit Cloudflare Workers`, `AlkCloud-Baseline-ReadOnly`, …), truyền qua env (không argv) | `docs/34` §3 |
| **CSP cho static assets** | `apps/web/public/_headers` — Workers Static Assets phục vụ asset **không** gọi Worker ⇒ phải khai báo header qua file `_headers` | `docs/34` §4 |
| **B2 storage thật** | Bucket `alkcloud-storage` (private, SSE-B2 `AES256`, CORS origin `cloud.alk.xx.kg`, expose `ETag`); 5 secret `B2_*` set; integration test 2/2; E2E file đầy đủ | `docs/35` §3 |
| **Relay `alkcloud-b2relay`** | Worker workers.dev chỉ nhận request server-side đã ký; token bí mật + host allowlist; deploy + health/401 checks | `docs/34` §4, `apps/b2relay/` |
| **Proxy trong storage adapter** | `packages/storage/src/b2.ts` thêm `B2ProxyConfig`; `signedFetch` đi qua relay, presign vẫn trỏ thẳng B2 | `docs/34` §4 |
| **CORS bucket** | `PutBucketCors` (SigV4) — origin `https://cloud.alk.xx.kg`, methods GET/PUT/HEAD, expose `ETag`, max-age 3600; xác minh bằng preflight + PUT thật | `docs/35` §3.1 |

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-02 | `backup-d1.ts` bỏ qua `--remote` ⇒ file backup không phản ánh dữ liệu production | Cao |
| BUG-03 | `e2e-production.ts`: message `assert()` tiêu thụ body ⇒ “Body has already been read” | Trung bình |
| BUG-04 | Prefix test có `/` ⇒ API cấm ký tự phân tách trong tên ⇒ payload 400 (lỗi ở harness, API đúng) | Trung bình |
| BUG-08 | `restore-drill.ts` không nhận file backup có sẵn ⇒ chưa từng chứng minh restore từ backup production | Trung bình |
| BUG-09 | `release-manifest.ts` mất danh sách secret khi tên secret kèm chú thích trạng thái | Cao |
| BUG-10 | Test chaos `T5` phụ thuộc `wrangler.toml` thật ⇒ không kiểm chứng được guard placeholder | Trung bình |
| BUG-12 | `alkApiCallsUsed` **luôn = 0** (Cloudflare gom request Worker-route vào `__unknown__`) ⇒ cảnh báo ngân sách riêng không bao giờ kích hoạt | Cao |
| BUG-13 | Chẩn đoán B2 sai: probe thiếu `/b2api/v2/` + B2 bỏ field JSON trong `AuthorizeAccountRequest` (phải dùng HTTP Basic) ⇒ kết luận nhầm “key không tồn tại” | Cao |
| BUG-14 | E2E gửi `passwordParams: 'sha256'` (6 ký tự) vi phạm `min(8)` ⇒ tạo share 400; web thật gửi `'sha256-v1'` | Trung bình |
| BUG-15 | E2E cleanup xoá object B2 khi metadata còn trong trash ⇒ `audit:storage` báo CRITICAL `missing_object` giả | Trung bình |
| BUG-16 | Worker zone-bound (`api.alk.xx.kg`) fetch B2 = **HTTP 525**, kể cả qua service binding; chỉ workers.dev công khai mới đi được | Cao |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| `infra/verify-all.sh` | restore drill chạy **từ file backup** (thay vì D1 local thường rỗng) · E2E dùng wrapper production · thêm bước kiểm tra gateway bằng HTTP |
| `infra/check-cloudflare-token.sh` | mỗi quyền dùng token riêng theo nhãn (analytics ≠ dns) ⇒ PASS=5/5 |
| `infra/check-dns.sh` | xác nhận gateway + route AlkCloud bằng **HTTP thật** thay vì SKIP |
| `scripts/lib/snapshot.ts` | `ALKCLOUD_WRANGLER_TOML` override ⇒ test guard dùng fixture, không phụ thuộc trạng thái production |
| `infra/check-b2.sh` | Maintenance key thành **OPTIONAL** (không còn `NOT_CONFIGURED`) · bổ sung kiểm tra region/endpoint |
| `infra/verify-all.sh` | Thêm check relay B2; thông điệp B2 không còn “blocked” |
| `infra/check-deployment.sh` | Kiểm tra `B2_RELAY_URL`, `workers_dev=true`, `B2_ALLOWED_HOST`, `B2_RELAY_TOKEN` trong secret bắt buộc |
| `scripts/e2e-production.ts` | `passwordParams: 'sha256-v1'`; cleanup giữ object B2 cho retention purge |

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
