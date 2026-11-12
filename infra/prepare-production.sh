#!/usr/bin/env bash
# AlkCloud — chuẩn bị production (KHÔNG deploy, KHÔNG tạo tài nguyên).
#
# Usage:
#   ./infra/prepare-production.sh              # kiểm tra + sinh checklist (read-only)
#   ./infra/prepare-production.sh --plan       # chỉ in kế hoạch, không ghi file
#
# Dependencies: bash, node, npm, python3.
# Expected output: kế hoạch từng bước + file checklist đã sinh (nếu không --plan).
# Exit code: 0 = chuẩn bị xong (không có nghĽa là production đã sẵn sàng),
#            1 = có lỗi chuẩn bị, 2 = thiếu dependency.
#
# SAFETY:
# - KHÔNG deploy, KHÔNG chạy migration production, KHÔNG tạo/sửa/xoá tài nguyên.
# - KHÔNG ghi secret vào file sinh ra (chỉ ghi TÊN secret + lệnh cần chạy).
# - File sinh ra: `deploy/production-checklist.md` (gitignored) + `deploy/secrets.env.example`
#   (chỉ tên biến, KHÔNG có giá trị).
# - Mọi bước "tạo tài nguyên" đều in lệnh để OWNER tự chạy, script không chạy.

set -uo pipefail
cd "$(dirname "$0")/.."

PLAN_ONLY=0
[ "${1:-}" = "--plan" ] && PLAN_ONLY=1

command -v node >/dev/null 2>&1 || { echo "FAIL — thiếu node"; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "FAIL — thiếu npm"; exit 2; }

echo "== AlkCloud — prepare production (read-only, KHÔNG deploy) =="

# 1. Kiểm tra bundle + secret list (read-only)
echo ""
echo "▶ Kiểm tra bundle & cấu hình deploy"
./infra/check-worker-limits.sh || echo "⚠ check-worker-limits có vấn đề (xem trên)"
./infra/check-deployment.sh || echo "⚠ check-deployment có vấn đề (xem trên)"

# 2. Danh sách secret cần đặt (tên + lệnh, KHÔNG có giá trị)
SECRETS=(AUTH_PEPPER BOOTSTRAP_SETUP_TOKEN B2_ENDPOINT B2_REGION B2_BUCKET \
  B2_ACCESS_KEY_ID B2_SECRET_ACCESS_KEY B2_MAINTENANCE_ACCESS_KEY_ID \
  B2_MAINTENANCE_SECRET_ACCESS_KEY TURNSTILE_SITE_KEY TURNSTILE_SECRET_KEY \
  ALERT_WEBHOOK_URL CLOUDFLARE_ANALYTICS_TOKEN CLOUDFLARE_ACCOUNT_ID)

if [ $PLAN_ONLY -eq 1 ]; then
  echo ""
  echo "▶ Kế hoạch (chỉ in, không ghi file)"
  for secret in "${SECRETS[@]}"; do
    echo "  npx wrangler secret put $secret   # giá trị KHÔNG nằm trong repo/log"
  done
  echo "  npx wrangler d1 create alkcloud"
  echo "  node --import tsx scripts/migrate.ts --remote --dry-run"
  exit 0
fi

mkdir -p deploy

{
  echo "# AlkCloud — secrets cần đặt cho Worker (TÊN, KHÔNG có giá trị)"
  echo "# Đặt bằng: npx wrangler secret put <TÊN>  (Worker 'alkcloud-api')"
  echo ""
  for secret in "${SECRETS[@]}"; do echo "$secret="; done
} > deploy/secrets.env.example

DB_NAME="$(sed -nE 's/^database_name[[:space:]]*=[[:space:]]*"([^"]+)"/\1/p' apps/api/wrangler.toml | head -1)"
DB_ID="$(sed -nE 's/^database_id[[:space:]]*=[[:space:]]*"([^"]+)"/\1/p' apps/api/wrangler.toml | head -1)"

cat > deploy/production-checklist.md <<EOF
# AlkCloud — Production launch checklist (sinh tự động, $(date -u '+%Y-%m-%d'))

> File này KHÔNG chứa secret. Thực hiện từng bước theo thứ tự.
> Chi tiết hướng dẫn: docs/20-OWNER-SETUP.md · docs/21-PRODUCTION-MIGRATION.md · docs/22-PRODUCTION-E2E.md

## 0. Trạng thái hiện tại
- database_name: \`${DB_NAME}\`
- database_id: \`${DB_ID}\`  ← còn placeholder = chưa tạo D1

## 1. Tài nguyên (OWNER tự tạo — KHÔNG tự ý)
- [ ] B3: bucket B2 riêng (private) + 2 app key giới hạn theo bucket → docs/20 §B3
- [ ] B4: token Cloudflare có Account Analytics:Read → docs/20 §B4
- [ ] B6: \`npx wrangler d1 create ${DB_NAME}\` → cập nhật database_id trong apps/api/wrangler.toml
- [ ] B7: CNAME \`cloud.alk.xx.kg\` → \`${DB_NAME}-web.<subdomain>.workers.dev\` → docs/20 §B7

## 2. Secrets (15 tên, đặt từng cái)
$(for secret in "${SECRETS[@]}"; do echo "- [ ] npx wrangler secret put $secret"; done)

## 3. Migration (chỉ khi owner duyệt)
- [ ] Backup trước: \`npm run backup:d1 -- --remote\`
- [ ] Dry-run: \`node --import tsx scripts/migrate.ts --remote --dry-run\`
- [ ] Apply: \`node --import tsx scripts/migrate.ts --remote\`
- [ ] Verify: \`./infra/check-d1.sh --remote\`

## 4. Deploy (cần phê duyệt riêng — Phase 3 KHÔNG deploy)
- [ ] \`npx wrangler deploy -c apps/api/wrangler.toml\`
- [ ] \`npx wrangler deploy -c apps/web/wrangler.toml\`
- [ ] Xác minh route không chặn gateway: \`curl https://api.alk.xx.kg/health\` (gateway) và
      \`curl https://api.alk.xx.kg/api/v1/health\` (AlkCloud)

## 5. Xác minh sau deploy
- [ ] \`./infra/check-owner-prerequisites.sh\`
- [ ] \`npm run test:e2e\` (cần B2 + D1 thật) → docs/22-PRODUCTION-E2E.md
- [ ] Cron: sau 1 giờ kiểm tra \`wrangler tail\` có log cron + audit mới

## 6. Rollback nếu route làm hỏng gateway
- [ ] Xoá route \`api.alk.xx.kg/api/v1/*\` khỏi apps/api/wrangler.toml và deploy lại Worker API
- [ ] Xác minh \`curl https://api.alk.xx.kg/health\` trả 200 của gateway
EOF

echo ""
echo "Đã sinh:"
echo "  deploy/production-checklist.md"
echo "  deploy/secrets.env.example  (chỉ tên biến, không có giá trị)"
echo ""
echo "Bước tiếp theo: làm theo docs/20-OWNER-SETUP.md (B3 → B4 → B6 → B7 → secrets)."
echo "Phase 3 KHÔNG deploy và KHÔNG tạo tài nguyên."
