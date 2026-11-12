#!/usr/bin/env bash
# AlkCloud — kiểm tra DNS + routing (READ-ONLY, KHÔNG sửa DNS).
#
# Usage:
#   ./infra/check-dns.sh
#
# Dependencies: curl (Cloudflare API), dig/nslookup (tuỳ chọn), python3.
# Expected output: mỗi dòng "<STATUS> <check> — <chi tiết>".
# Exit code: 0 = không FAIL, 1 = có FAIL, 2 = thiếu dependency.
#
# SAFETY:
# - Chỉ đọc DNS công khai + Cloudflare API GET. KHÔNG tạo/sửa/xoá record.
# - KHÔNG in token.
# - KHÔNG chạm vào gateway `api-gateway` (route hiện hữu của zone).

set -uo pipefail

PASS=0; FAIL=0; NOT_CONFIGURED=0; PERMISSION_DENIED=0; SKIPPED=0
ok()     { printf 'PASS              %s — %s\n' "$1" "$2"; PASS=$((PASS+1)); }
fail()   { printf 'FAIL              %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
nc()     { printf 'NOT_CONFIGURED    %s — %s\n' "$1" "$2"; NOT_CONFIGURED=$((NOT_CONFIGURED+1)); }
denied() { printf 'PERMISSION_DENIED %s — %s\n' "$1" "$2"; PERMISSION_DENIED=$((PERMISSION_DENIED+1)); }
skip()   { printf 'SKIPPED           %s — %s\n' "$1" "$2"; SKIPPED=$((SKIPPED+1)); }

command -v python3 >/dev/null 2>&1 || { echo "FAIL — thiếu python3"; exit 4; }

ZONE_ID="${CLOUDFLARE_ZONE_ID:-882ba5243fa3f704c450f821965fa950}"
TOKEN="${CF_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r /home/ubuntu/.cloudflare/token ]; then
  TOKEN="$(grep -m1 '^CF_API_TOKEN=' /home/ubuntu/.cloudflare/token | cut -d= -f2- | tr -d '\r\n')"
fi

printf '== DNS & routing (read-only) ==\n'

# 1. DNS công khai cho cloud.alk.xx.kg (không cần token)
if command -v dig >/dev/null 2>&1; then
  RECORDS="$(dig +short cloud.alk.xx.kg A 2>/dev/null | tr '\n' ' ')"
  CNAME="$(dig +short cloud.alk.xx.kg CNAME 2>/dev/null | tr '\n' ' ')"
  if [ -n "$RECORDS" ] || [ -n "$CNAME" ]; then
    ok "dns:cloud.alk.xx.kg" "A=${RECORDS:-—} CNAME=${CNAME:-—}"
  else
    nc "dns:cloud.alk.xx.kg" "chưa có record A/CNAME (xem docs/20 §B7)"
  fi
  API_RECORDS="$(dig +short api.alk.xx.kg A 2>/dev/null | tr '\n' ' ')"
  if [ -n "$API_RECORDS" ]; then
    ok "dns:api.alk.xx.kg" "A=${API_RECORDS}"
  else
    skip "dns:api.alk.xx.kg" "không phân giải được từ host này (có thể do DNS resolver nội bộ)"
  fi
else
  skip "dns:cloud.alk.xx.kg" "thiếu lệnh dig — cài dnsutils để kiểm tra"
fi

# 2. Record trong Cloudflare (read-only)
if [ -z "$TOKEN" ]; then
  nc "cf:dns-records" "không có CF_API_TOKEN — bỏ qua kiểm tra record trong Cloudflare"
elif command -v curl >/dev/null 2>&1; then
  RESP="$(curl -s --max-time 20 -H "Authorization: Bearer ${TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=cloud.alk.xx.kg")"
  COUNT="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("result_info",{}).get("total_count", -1))
except Exception:
    print(-1)' 2>/dev/null)"
  if [ "$COUNT" = "-1" ]; then
    denied "cf:dns-records" "không đọc được danh sách record (token thiếu quyền Zone:DNS:Read?)"
  elif [ "$COUNT" = "0" ]; then
    nc "cf:dns-records" "cloud.alk.xx.kg chưa có record trong Cloudflare (docs/20 §B7)"
  else
    DETAIL="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(", ".join(f"{r.get(\"type\")}→{r.get(\"content\")} (proxied={r.get(\"proxied\")})" for r in d.get("result",[])))
except Exception:
    print("")' 2>/dev/null)"
    ok "cf:dns-records" "$DETAIL"
  fi
else
  skip "cf:dns-records" "thiếu curl"
fi

# 3. Route của AlkCloud API trong wrangler.toml
if grep -q 'pattern = "api.alk.xx.kg/api/v1/\*"' apps/api/wrangler.toml; then
  ok "route:api" "wrangler.toml khai báo route api.alk.xx.kg/api/v1/*"
else
  fail "route:api" "thiếu route api.alk.xx.kg/api/v1/* trong apps/api/wrangler.toml"
fi

# 4. Gateway hiện hữu: KHÔNG được sửa — chỉ nhắc nhở
if [ -d /home/ubuntu/cf-api-gateway ]; then
  if grep -q 'api.alk.xx.kg' /home/ubuntu/cf-api-gateway/wrangler.jsonc 2>/dev/null; then
    skip "gateway:api-gateway" "gateway hiện hữu dùng api.alk.xx.kg — route /api/v1/* của AlkCloud phải CÙNG zone, Cloudflare sẽ ưu tiên route có pattern dài hơn (cần xác nhận sau khi deploy)"
  else
    ok "gateway:api-gateway" "gateway không khai báo api.alk.xx.kg — không xung đột route"
  fi
else
  skip "gateway:api-gateway" "không thấy thư mục gateway trên host này"
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
