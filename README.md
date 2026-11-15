# AlkCloud

Ứng dụng lưu trữ đám mây cá nhân (file manager + chia sẻ) chạy hoàn toàn trên **Cloudflare Workers Free + D1 + Backblaze B2**.

- **Web**: React 19 + Vite (`apps/web`) — Cloudflare Worker static assets.
- **API**: Cloudflare Worker (`apps/api`) — REST `/api/v1/*`, cookie session `__Secure-alk_session` + CSRF, D1, presigned URL tới B2.
- **Relay B2**: Worker (`apps/b2relay`) — proxy S3 có allowlist host, giữ credential B2 ở Worker secret.
- **Packages**: `core` (validation/domain), `db` (D1 repositories/migrations), `storage` (S3/B2), `auth` (PBKDF2 session).

Tính năng: quản lý thư mục/file, upload single-part + multipart (presign), tải xuống full/Range, thùng rác 30 ngày + purge, chia sẻ có mật khẩu (hết hạn/giới hạn lượt tải/thu hồi), quota + degradation mode, audit log, backup/restore D1, E2E production.

## Bắt đầu

```bash
npm install
cp .env.example .env          # điền giá trị local (KHÔNG commit)
npm run db:migrate:local      # tạo D1 local
npm run dev:api               # API :8787
npm run dev:web               # web :5174
```

Kiểm tra: `npm run verify` (typecheck + test + build) · `npm run check:limits` · `./infra/check-deployment.sh`.
Deploy: `./infra/prepare-production.sh` → `npx wrangler deploy -c apps/api/wrangler.toml` → `npx wrangler deploy -c apps/web/wrangler.toml` → `npm run test:e2e`.

## Bảo mật

Repo **không chứa secret**. Mọi credential (token Cloudflare, key B2, `AUTH_PEPPER`, bootstrap token…) đặt bằng `wrangler secret put` hoặc file `.env` local (đã gitignore). File mẫu `.env.example` chỉ có placeholder. Quét lại: `./infra/check-secrets.sh`.

> Đây là dự án homelab cá nhân; tên miền/tài nguyên trong tài liệu là của owner và có thể không tồn tại khi bạn clone.

## Tài liệu

Xem [`CHANGELOG.md`](CHANGELOG.md) cho lịch sử thay đổi. Các tài liệu thiết kế/vận hành nội bộ không được đưa vào bản public; các bước kiểm tra chạy local bằng `npm run verify` + `./infra/verify-all.sh`.
