#!/usr/bin/env bash
# AlkCloud — kiểm tra hop relay workers.dev tới Backblaze B2 (READ-ONLY).
#
# LÝ DO: Worker gắn route zone `alk.xx.kg` fetch B2 trả 525 (đo thật 13/11/2026)
#   ⇒ request server-side phải đi qua `alkcloud-b2relay.workers.dev`.
#
# Script chỉ kiểm tra:
#   1. `/health` trả 200 + status ok (relay sống).
#   2. Gọi relay không token ⇒ 401 (không phải open proxy).
# Không gửi credential, không gọi B2, không in URL đã ký.
#
# Exit code: 0 = PASS · 1 = FAIL · 2 = NOT_CONFIGURED · 4 = thiếu dependency.

set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; NOT_CONFIGURED=0
ok()   { printf 'PASS              %s — %s\n' "$1" "$2"; PASS=$((PASS+1)); }
fail() { printf 'FAIL              %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
nc()   { printf 'NOT_CONFIGURED    %s — %s\n' "$1" "$2"; NOT_CONFIGURED=$((NOT_CONFIGURED+1)); }

command -v curl >/dev/null 2>&1 || { echo "FAIL — thiếu curl"; exit 4; }

RELAY_URL="${ALKCLOUD_B2_RELAY_URL:-$(grep -m1 '^B2_RELAY_URL' apps/api/wrangler.toml 2>/dev/null | cut -d'"' -f2)}"
if [ -z "$RELAY_URL" ]; then
  nc "relay-url" "B2_RELAY_URL chưa khai báo trong apps/api/wrangler.toml"
  printf '\nTổng kết: PASS=%s FAIL=%s NOT_CONFIGURED=%s\n' "$PASS" "$FAIL" "$NOT_CONFIGURED"
  exit 2
fi
ok "relay-url" "$RELAY_URL"

HEALTH="$(curl -sS -A 'alkcloud-check/1.0' --max-time 20 -o /tmp/alkcloud-b2relay-health.$$ -w '%{http_code}' "$RELAY_URL/health" 2>/dev/null || echo 000)"
BODY="$(cat /tmp/alkcloud-b2relay-health.$$ 2>/dev/null || true)"
rm -f /tmp/alkcloud-b2relay-health.$$
if [ "$HEALTH" = "200" ] && printf '%s' "$BODY" | grep -q '"status":"ok"'; then
  ok "relay-health" "HTTP 200 + status ok"
else
  fail "relay-health" "HTTP ${HEALTH} — relay không sẵn sàng"
fi

NOAUTH="$(curl -sS -A 'alkcloud-check/1.0' --max-time 20 -o /dev/null -w '%{http_code}' "$RELAY_URL/" 2>/dev/null || echo 000)"
if [ "$NOAUTH" = "401" ]; then
  ok "relay-auth" "không token ⇒ 401 (không phải open proxy)"
else
  fail "relay-auth" "không token phải 401, nhận ${NOAUTH}"
fi

printf '\nTổng kết: PASS=%s FAIL=%s NOT_CONFIGURED=%s\n' "$PASS" "$FAIL" "$NOT_CONFIGURED"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$NOT_CONFIGURED" -gt 0 ]; then exit 2; fi
exit 0
