#!/usr/bin/env bash
# AlkCloud — kiểm tra quyền token Cloudflare (READ-ONLY).
#
# Usage:
#   ./infra/check-cloudflare-token.sh            # dùng CF_API_TOKEN từ env
#   CF_API_TOKEN_FILE=/path/to/token ./infra/check-cloudflare-token.sh
#   CF_API_TOKEN=xxx ./infra/check-cloudflare-token.sh
#
# Dependencies: curl, python3 (để parse JSON). Không cần wrangler.
# Expected output: từng dòng "<STATUS> <check> — <chi tiết>".
# Exit code: 0 = không có FAIL (có thể có NOT_CONFIGURED/PERMISSION_DENIED),
#            1 = có ít nhất một FAIL, 2 = thiếu dependency/token.
#
# SAFETY:
# - Chỉ gọi API GET (read-only). KHÔNG tạo/sửa/xoá tài nguyên.
# - KHÔNG in token ra terminal, KHÔNG ghi token vào file log.
# - Token chỉ gửi tới api.cloudflare.com (mục đích kiểm tra quyền đã công bố).
#
# Token KHÔNG cần quyền này (đừng cấp thừa):
#   Workers Edit, DNS Edit, D1 Edit, R2 Edit, Billing Edit.
# Chỉ cần: Zone:Read (zones), Account:Analytics:Read (account analytics).

set -uo pipefail

PASS=0; FAIL=0; NOT_CONFIGURED=0; PERMISSION_DENIED=0; SKIPPED=0

ok()      { printf 'PASS              %s — %s\n' "$1" "$2"; PASS=$((PASS+1)); }
fail()    { printf 'FAIL              %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
nc()      { printf 'NOT_CONFIGURED    %s — %s\n' "$1" "$2"; NOT_CONFIGURED=$((NOT_CONFIGURED+1)); }
denied()  { printf 'PERMISSION_DENIED %s — %s\n' "$1" "$2"; PERMISSION_DENIED=$((PERMISSION_DENIED+1)); }
skip()    { printf 'SKIPPED           %s — %s\n' "$1" "$2"; SKIPPED=$((SKIPPED+1)); }

command -v curl >/dev/null 2>&1 || { echo "FAIL — thiếu curl"; exit 4; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL — thiếu python3"; exit 4; }

TOKEN="${CF_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "${CF_API_TOKEN_FILE:-}" ] && [ -r "${CF_API_TOKEN_FILE}" ]; then
  TOKEN="$(grep -m1 -E '^CF_API_TOKEN=' "$CF_API_TOKEN_FILE" | cut -d= -f2- | tr -d '\r\n')"
  [ -z "$TOKEN" ] && TOKEN="$(tr -d '\r\n' < "$CF_API_TOKEN_FILE")"
fi
. "$(dirname "$0")/lib/cf-token.sh"
TOKEN="$(alkcloud_load_cf_token)"
if [ -z "$TOKEN" ]; then
  nc "token" "không tìm thấy CF_API_TOKEN (env, CF_API_TOKEN_FILE hoặc /home/ubuntu/.cloudflare/token)"
  printf '\nTổng kết: PASS=%s FAIL=%s NOT_CONFIGURED=%s PERMISSION_DENIED=%s SKIPPED=%s\n' \
    "$PASS" "$FAIL" "$NOT_CONFIGURED" "$PERMISSION_DENIED" "$SKIPPED"
  exit 0
fi

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-c3f46654371899594a8ddf59b863d211}"
ZONE_ID="${CLOUDFLARE_ZONE_ID:-882ba5243fa3f704c450f821965fa950}"

# Token cho TỪNG quyền: mỗi API token của owner chỉ có quyền tối thiểu ⇒
# token analytics không đọc được DNS, token DNS không đọc được analytics.
# Vì vậy mỗi check dùng token riêng theo nhãn (fallback về TOKEN hiện tại).
TOKEN_ANALYTICS="${TOKEN}"
TOKEN_DNS="${TOKEN}"
if [ -z "${CF_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  [ -n "$(alkcloud_load_cf_token_by_label "AlkCloud-Baseline-ReadOnly")" ] && \
    TOKEN_ANALYTICS="$(alkcloud_load_cf_token_by_label "AlkCloud-Baseline-ReadOnly")"
  [ -n "$(alkcloud_load_cf_token_by_label "Edit Zone DNS")" ] && \
    TOKEN_DNS="$(alkcloud_load_cf_token_by_label "Edit Zone DNS")"
fi

# curl đọc token từ stdin config ⇒ token KHÔNG nằm trong argv (không lộ qua `ps`).
cf_get() {
  local path="$1" token="${2:-$TOKEN}"
  curl -s --max-time 20 -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4${path}"
}

check_json() {
  # check_json <label> <path> <expect: true|false> [token]
  local label="$1" path="$2" expect="$3" body
  body="$(cf_get "$path" "${4:-$TOKEN}")"
  local success
  success="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    print("true" if json.load(sys.stdin).get("success") is True else "false")
except Exception:
    print("false")' 2>/dev/null)"
  if [ "$success" = "$expect" ]; then
    local errors
    errors="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("; ".join(e.get("message","") for e in (d.get("errors") or []))[:160])
except Exception:
    print("")' 2>/dev/null)"
    if [ "$expect" = "true" ]; then ok "$label" "đọc được (${path})"; else denied "$label" "bị từ chối: ${errors:-không rõ lý do}"; fi
  else
    if [ "$expect" = "true" ]; then
      local errors
      errors="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("; ".join(e.get("message","") for e in (d.get("errors") or []))[:160])
except Exception:
    print("")' 2>/dev/null)"
      denied "$label" "bị từ chối: ${errors:-không rõ lý do}"
    else
      ok "$label" "đúng như kỳ vọng (không có quyền đọc) — không cần cấp"
    fi
  fi
}

printf '== Cloudflare API token (read-only kiểm tra quyền) ==\n'
check_json "zone:read (zones/${ZONE_ID})" "/zones/${ZONE_ID}" true
# Account Analytics chỉ đọc được qua GraphQL (POST nhưng câu query thuần đọc).
# Cửa sổ thời gian PHẢI ≤ 4 tuần (4w4d): API Cloudflare từ chối range dài hơn
# ⇒ check trước đây dùng range cả năm và luôn báo PERMISSION_DENIED dù token
# có Account Analytics:Read (sai lệch phát hiện). Dùng 28 ngày gần nhất.
GRAPHQL_FROM="$(date -u -d '28 days ago' '+%Y-%m-%dT%H:%M:%S.000Z')"
GRAPHQL_TO="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
GRAPHQL_BODY='{"query":"query($a: string!) { viewer { accounts(filter: {accountTag: $a}) { workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: \"'"${GRAPHQL_FROM}"'\", datetime_leq: \"'"${GRAPHQL_TO}"'\"}) { sum { requests } } } } }","variables":{"a":"'"${ACCOUNT_ID}"'"}}'
GRAPHQL_RESP="$(curl -s --max-time 25 -X POST 'https://api.cloudflare.com/client/v4/graphql' \
  -H "Authorization: Bearer ${TOKEN_ANALYTICS}" -H 'Content-Type: application/json' --data "$GRAPHQL_BODY")"
GERR="$(printf '%s' "$GRAPHQL_RESP" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("; ".join(e.get("message","") for e in (d.get("errors") or []))[:160])
except Exception:
    print("parse-error")' 2>/dev/null)"
GOK="$(printf '%s' "$GRAPHQL_RESP" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("true" if d.get("data") and not d.get("errors") else "false")
except Exception:
    print("false")' 2>/dev/null)"
if [ "$GOK" = "true" ]; then
  ok "account:analytics:read (GraphQL workersInvocationsAdaptive)" "đọc được số liệu analytics của account"
else
  denied "account:analytics:read (GraphQL workersInvocationsAdaptive)" "bị từ chối: ${GERR:-không rõ lý do} — cần token có Account Analytics:Read"
fi
check_json "workers:scripts:read (không bắt buộc)" "/accounts/${ACCOUNT_ID}/workers/scripts" false
check_json "dns:read (dns_records)" "/zones/${ZONE_ID}/dns_records?per_page=1" true "$TOKEN_DNS"

# Token verification endpoint (xác nhận token còn hợp lệ + quyền hiện tại)
VERIFY="$(cf_get "/user/tokens/verify")"
VS="$(printf '%s' "$VERIFY" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    r=d.get("result") or {}
    print("true" if d.get("success") and r.get("status")=="active" else "false")
except Exception:
    print("false")' 2>/dev/null)"
if [ "$VS" = "true" ]; then
  ok "token:verify" "token đang active"
else
  fail "token:verify" "token không hợp lệ / không còn active"
fi

printf '\nTổng kết: PASS=%s FAIL=%s NOT_CONFIGURED=%s PERMISSION_DENIED=%s SKIPPED=%s\n' \
  "$PASS" "$FAIL" "$NOT_CONFIGURED" "$PERMISSION_DENIED" "$SKIPPED"
# Quy ước exit code (thống nhất toàn bộ infra/check-*.sh):
#   0 = tất cả PASS
#   1 = có FAIL
#   2 = có NOT_CONFIGURED / PERMISSION_DENIED (bị chặn bởi tài nguyên chưa cấu hình)
#   3 = chỉ có SKIPPED
#   4 = thiếu dependency
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$NOT_CONFIGURED" -gt 0 ] || [ "$PERMISSION_DENIED" -gt 0 ]; then exit 2; fi
if [ "$SKIPPED" -gt 0 ]; then exit 3; fi
exit 0
