#!/usr/bin/env bash
# Kiểm tra toàn bộ tài nguyên AlkCloud đã sẵn sàng chưa.
#
# Script CHỈ ĐỌC — không tạo, không sửa, không xoá bất kỳ tài nguyên nào.
# Dùng để kiểm tra trạng thái trước/sau khi owner cấu hình.
#
# Usage: ./infra/check-readiness.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

PASS=0
WARN=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head_ "1. Toolchain"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  NODE_MAJOR="$(printf '%s' "$NODE_V" | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$NODE_MAJOR" -ge 22 ]; then ok "node $NODE_V"; else bad "node $NODE_V — cần >= 22.5 (node:sqlite)"; fi
else
  bad "node chưa cài"
fi
if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version)"; else bad "npm chưa cài"; fi
if [ -d node_modules ]; then ok "node_modules đã cài"; else warn "chưa cài dependency — chạy: npm ci"; fi

head_ "2. Typecheck + test + build"
if npm run typecheck >/tmp/alkcloud-check-typecheck.log 2>&1; then
  ok "typecheck sạch"
else
  bad "typecheck lỗi — xem /tmp/alkcloud-check-typecheck.log"
fi
if npm test >/tmp/alkcloud-check-test.log 2>&1; then
  TEST_COUNT="$(grep -E '^# pass ' /tmp/alkcloud-check-test.log | awk '{print $3}' | tail -1)"
  ok "test pass (${TEST_COUNT:-?})"
else
  bad "test fail — xem /tmp/alkcloud-check-test.log"
fi
if npm run build >/tmp/alkcloud-check-build.log 2>&1; then
  ok "build thành công"
else
  bad "build lỗi — xem /tmp/alkcloud-check-build.log"
fi

head_ "3. Config trong wrangler.toml"
API_TOML="apps/api/wrangler.toml"
if [ -f "$API_TOML" ]; then
  if grep -q 'REPLACE_WITH_D1_DATABASE_ID' "$API_TOML"; then
    bad "apps/api/wrangler.toml: database_id vẫn là placeholder — cần 'wrangler d1 create alkcloud'"
  else
    ok "D1 database_id đã điền"
  fi
  if grep -q 'routes' "$API_TOML"; then
    ok "route API đã khai báo"
  else
    warn "chưa khai báo route API"
  fi
else
  bad "thiếu $API_TOML"
fi

WEB_TOML="apps/web/wrangler.toml"
if [ -f "$WEB_TOML" ]; then
  if grep -qE '^\s*#\s*\{\s*pattern' "$WEB_TOML" || ! grep -q 'pattern' "$WEB_TOML"; then
    warn "route web còn comment — bật sau khi deploy workers.dev thành công"
  else
    ok "route web đã bật"
  fi
else
  bad "thiếu $WEB_TOML"
fi

head_ "4. Secrets (kiểm tra TÊN, không đọc giá trị)"
if command -v npx >/dev/null 2>&1 && [ -f "$API_TOML" ]; then
  if npx wrangler secret list -c "$API_TOML" >/tmp/alkcloud-check-secrets.log 2>&1; then
    for name in AUTH_PEPPER BOOTSTRAP_SETUP_TOKEN B2_ACCESS_KEY_ID B2_SECRET_ACCESS_KEY; do
      if grep -q "$name" /tmp/alkcloud-check-secrets.log; then
        ok "secret $name đã set"
      else
        warn "secret $name chưa set"
      fi
    done
  else
    warn "không đọc được danh sách secret (chưa đăng nhập Cloudflare?) — xem /tmp/alkcloud-check-secrets.log"
  fi
else
  warn "bỏ qua kiểm tra secret"
fi

head_ "5. Cloudflare (read-only)"
CF_TOKEN="${CF_API_TOKEN:-}"
if [ -z "$CF_TOKEN" ] && [ -r /home/ubuntu/.cloudflare/token ]; then
  # File token lưu dạng "KEY=VALUE" (CF_API_TOKEN=..., CF_TUNNEL_TOKEN=...).
  CF_TOKEN="$(grep -m1 '^CF_API_TOKEN=' /home/ubuntu/.cloudflare/token | cut -d= -f2- | tr -d '\r\n')"
fi
if [ -z "$CF_TOKEN" ]; then
  warn "không có CF_API_TOKEN — bỏ qua kiểm tra Cloudflare"
else
  ZONE_ID="${CLOUDFLARE_ZONE_ID:-882ba5243fa3f704c450f821965fa950}"
  ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-c3f46654371899594a8ddf59b863d211}"

  if curl -s --max-time 20 "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}" \
      -H "Authorization: Bearer ${CF_TOKEN}" | grep -q '"success":true'; then
    ok "đọc được zone alk.xx.kg"
  else
    warn "không đọc được zone (token thiếu quyền hoặc sai zone id)"
  fi

  if curl -s --max-time 20 "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts" \
      -H "Authorization: Bearer ${CF_TOKEN}" | grep -q '"success":true'; then
    SCRIPTS="$(curl -s --max-time 20 "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts" \
      -H "Authorization: Bearer ${CF_TOKEN}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(x.get("id","") for x in (d.get("result") or [])))' 2>/dev/null)"
    if printf '%s' "$SCRIPTS" | grep -q 'alkcloud-api'; then
      ok "Worker alkcloud-api đã tồn tại"
    else
      warn "Worker alkcloud-api chưa deploy"
    fi
    if printf '%s' "$SCRIPTS" | grep -q 'alkcloud-web'; then
      ok "Worker alkcloud-web đã tồn tại"
    else
      warn "Worker alkcloud-web chưa deploy"
    fi
  else
    # Token CF_API_TOKEN hiện tại đọc được `nodes/settings` nhưng bị từ chối ở
    # `workers/scripts` và `workersInvocationsAdaptive` — cần token riêng có
    # scope Account Analytics / Workers Scripts Read.
    warn "không đọc được danh sách Worker (token thiếu quyền Workers Scripts Read?)"
  fi

  if curl -s --max-time 20 "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=cloud.alk.xx.kg" \
      -H "Authorization: Bearer ${CF_TOKEN}" | grep -q '"count":1'; then
    ok "DNS cloud.alk.xx.kg đã tồn tại"
  elif curl -s --max-time 20 "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=cloud.alk.xx.kg" \
      -H "Authorization: Bearer ${CF_TOKEN}" | grep -q '"count":0'; then
    warn "DNS cloud.alk.xx.kg chưa tạo"
  else
    warn "không kiểm tra được DNS"
  fi
fi

head_ "6. Backblaze B2"
if command -v rclone >/dev/null 2>&1; then
  if rclone listremotes 2>/dev/null | grep -q '^terabox:'; then
    ok "rclone remote terabox đã cấu hình"
  else
    warn "rclone chưa có remote terabox"
  fi
  if rclone listremotes 2>/dev/null | grep -q '^b2alk:'; then
    ok "rclone remote b2alk đã cấu hình (backup B2)"
  else
    warn "rclone chưa có remote b2alk — backup B2 chưa chạy được"
  fi
else
  warn "rclone chưa cài — backup offsite chưa chạy được"
fi

head_ "Tổng kết"
printf '  pass=%s  warn=%s  fail=%s\n\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Còn %s mục FAIL — xem docs/19-verification-ledger.md.\n' "$FAIL"
  exit 1
fi
printf 'Không có mục FAIL. Các mục WARN cần owner xử lý (xem EXECUTION_TRACKER.md).\n'
exit 0
