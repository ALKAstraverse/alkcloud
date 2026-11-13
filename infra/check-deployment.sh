#!/usr/bin/env bash
# Kiểm tra gói deployment AlkCloud ở mức tĩnh (KHÔNG deploy, KHÔNG gọi mạng).
#
#   ./infra/check-deployment.sh
#
# Kiểm tra:
#   1. wrangler.toml không còn placeholder bắt buộc (database_id).
#   2. Route/Cron/vars khớp quyết định kiến trúc (api.alk.xx.kg/api/v1/*, cron 17 * * * *).
#   3. Danh sách secret bắt buộc có trong tài liệu (không đọc giá trị).
#   4. Build web tồn tại + không chứa secret.
set -euo pipefail

cd "$(dirname "$0")/.."
STATUS=0

fail() { echo "✗ $*" >&2; STATUS=1; }
ok() { echo "✓ $*"; }

WRANGLER="apps/api/wrangler.toml"
[[ -f "$WRANGLER" ]] || { echo "✗ thiếu $WRANGLER" >&2; exit 1; }

if grep -q 'REPLACE_WITH_D1_DATABASE_ID' "$WRANGLER"; then
  echo "⚠ database_id vẫn là placeholder — BLOCKED (B6) cho tới khi tạo D1 thật" >&2
else
  ok "database_id đã cấu hình"
fi

grep -q 'pattern = "api.alk.xx.kg/api/v1/\*"' "$WRANGLER" \
  && ok "route api.alk.xx.kg/api/v1/*" \
  || fail "route api.alk.xx.kg/api/v1/* không khớp"

grep -q 'crons = \["17 \* \* \* \*"\]' "$WRANGLER" \
  && ok "cron 17 * * * *" \
  || fail "cron không khớp (kỳ vọng 17 * * * * — hourly)"

grep -q 'workers_dev = false' "$WRANGLER" \
  && ok "workers_dev = false" \
  || fail "workers_dev phải false (chỉ dùng route production)"

grep -q 'B2_RELAY_URL = "https://alkcloud-b2relay.alkev.workers.dev"' "$WRANGLER" \
  && ok "B2_RELAY_URL trỏ relay workers.dev" \
  || fail "B2_RELAY_URL chưa khai báo (Worker gắn route bị 525 khi fetch B2)"

RELAY="apps/b2relay/wrangler.toml"
if [[ -f "$RELAY" ]]; then
  grep -q 'workers_dev = true' "$RELAY" \
    && ok "relay: workers_dev = true (bắt buộc)" \
    || fail "relay phải workers_dev = true"
  grep -q 'B2_ALLOWED_HOST = "s3.ca-east-006.backblazeb2.com"' "$RELAY" \
    && ok "relay: B2_ALLOWED_HOST đúng" \
    || fail "relay: B2_ALLOWED_HOST không khớp"
else
  fail "thiếu $RELAY"
fi

for secret in AUTH_PEPPER BOOTSTRAP_SETUP_TOKEN B2_ENDPOINT B2_REGION B2_BUCKET B2_ACCESS_KEY_ID B2_SECRET_ACCESS_KEY B2_RELAY_TOKEN B2_MAINTENANCE_ACCESS_KEY_ID B2_MAINTENANCE_SECRET_ACCESS_KEY TURNSTILE_SITE_KEY TURNSTILE_SECRET_KEY ALERT_WEBHOOK_URL CLOUDFLARE_ANALYTICS_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  grep -q "$secret" "$WRANGLER" && ok "secret được khai báo: $secret" || fail "thiếu khai báo secret: $secret"
done

if [[ -d apps/web/dist ]]; then
  # Tên biến có thể xuất hiện trong copy UI hướng dẫn; chỉ chặn dạng gán giá trị.
  if grep -rEl '(AUTH_PEPPER|BOOTSTRAP_SETUP_TOKEN|B2_SECRET_ACCESS_KEY|B2_APP_KEY|TURNSTILE_SECRET_KEY)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/=_-]{8,}' apps/web/dist >/dev/null 2>&1; then
    fail "bundle web có dấu hiệu chứa giá trị secret (kiểm tra lại build)"
  else
    ok "bundle web không chứa giá trị secret"
  fi
else
  fail "chưa build web (npm run build:web) — không kiểm tra được bundle"
fi

if [[ -f docs/17-deployment-runbook.md ]]; then
  grep -qi 'wrangler secret put' docs/17-deployment-runbook.md \
    && ok "runbook có bước wrangler secret put" \
    || fail "runbook thiếu bước wrangler secret put"
else
  fail "thiếu docs/17-deployment-runbook.md"
fi

exit "$STATUS"
