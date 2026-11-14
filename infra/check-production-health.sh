#!/usr/bin/env bash
# AlkCloud — kiểm tra sức khoẻ production (read-only, qua HTTP).
#
#   ./infra/check-production-health.sh
#   ALKCLOUD_API_URL=https://api.alk.xx.kg/api/v1 ./infra/check-production-health.sh
#
# Chỉ đọc — KHÔNG thay đổi dữ liệu, KHÔNG gọi endpoint ghi.
#
# Trạng thái trả về:
#   PASS       — Worker đã deploy và phản hồi đúng
#   NOT_DEPLOYED — Worker AlkCloud chưa deploy (route chưa có) — KHÔNG phải lỗi
#   FAIL       — Worker đã deploy nhưng phản hồi sai
#
# Kiểm tra:
#  1. AlkCloud API: /health trả 200 + service đúng.
#  2. Gateway KHÔNG bị route của AlkCloud che: https://api.alk.xx.kg/health vẫn trả 200.
#  3. Web: https://cloud.alk.xx.kg/ trả 200, hoặc 307 → /app/<version>/ trả 200
#     (entry point có version — Phase 6; nếu đã tạo DNS).
#  4. Header bảo mật: HSTS, nosniff, frame-options trên response API.
#  5. Route API không rò endpoint nội bộ (404 với mã chuẩn).
set -uo pipefail
cd "$(dirname "$0")/.."

API_URL="${ALKCLOUD_API_URL:-https://api.alk.xx.kg/api/v1}"
GATEWAY_URL="${ALKCLOUD_GATEWAY_URL:-https://api.alk.xx.kg}"
WEB_URL="${ALKCLOUD_WEB_URL:-https://cloud.alk.xx.kg}"

FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "── 1. AlkCloud API /health ──"
RESP="$(curl -sS --max-time 20 -D /tmp/alkcloud-health-headers.txt "${API_URL}/health" 2>/dev/null || true)"
DEPLOYED=0
if printf '%s' "$RESP" | grep -q '"status":"ok"'; then
  DEPLOYED=1
  pass "health trả status=ok"
  if printf '%s' "$RESP" | grep -q '"service":"alkcloud-api"'; then
    pass "service đúng (alkcloud-api)"
  else
    fail "service không đúng: ${RESP:0:160}"
  fi
elif printf '%s' "$RESP" | grep -q '"not_found"'; then
  # Gateway đang trả 404 cho /api/v1/* ⇒ Worker AlkCloud chưa deploy route.
  skip "Worker AlkCloud chưa deploy (gateway trả 404 cho ${API_URL}/health)"
  skip "các kiểm tra cần Worker đã deploy sẽ được bỏ qua"
else
  fail "health không trả ok: ${RESP:0:160}"
fi

echo "── 2. Gateway không bị route che ──"
GW_RESP="$(curl -sS --max-time 20 -o /tmp/alkcloud-gw-body.txt -w '%{http_code}' "${GATEWAY_URL}/health" 2>/dev/null || true)"
GW_RESP="${GW_RESP:-000}"
if [ "$GW_RESP" = "200" ]; then
  pass "gateway /health trả 200"
elif [ "$GW_RESP" = "000" ]; then
  skip "không gọi được gateway (mạng/DNS chưa sẵn sàng)"
else
  fail "gateway /health trả ${GW_RESP} — route có thể đã che gateway!"
fi

echo "── 3. Web app ──"
WEB_RESP="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "${WEB_URL}/" 2>/dev/null || true)"
WEB_RESP="${WEB_RESP:-000}"
if [ "$WEB_RESP" = "200" ]; then
  pass "web trả 200"
elif [ "$WEB_RESP" = "307" ]; then
  # Phase 6: `/` redirect tới `/app/<version>/` để né cache edge. Phải follow
  # redirect và xác nhận đích trả 200 (nếu không, SPA chết dù entry point sống).
  WEB_FINAL="$(curl -sSL --max-time 20 -o /dev/null -w '%{http_code}' "${WEB_URL}/" 2>/dev/null || true)"
  if [ "${WEB_FINAL:-000}" = "200" ]; then
    pass "web 307 → /app/<version>/ trả 200 (entry point có version — Phase 6)"
  else
    fail "web redirect đích trả ${WEB_FINAL:-000}"
  fi
elif [ "$WEB_RESP" = "000" ]; then
  skip "chưa có DNS cloud.alk.xx.kg (B7 chưa hoàn tất)"
else
  fail "web trả ${WEB_RESP}"
fi

echo "── 4. Header bảo mật ──"
HEADERS="$(cat /tmp/alkcloud-health-headers.txt 2>/dev/null || true)"
for HEADER in "strict-transport-security" "x-content-type-options" "x-frame-options" "referrer-policy"; do
  if printf '%s' "$HEADERS" | grep -qi "$HEADER"; then
    pass "có $HEADER"
  else
    fail "thiếu $HEADER"
  fi
done

echo "── 5. 404 chuẩn (không rò chi tiết) ──"
NOT_FOUND="$(curl -sS --max-time 20 "${API_URL}/khong-ton-tai-xyz" 2>/dev/null || true)"
if [ "$DEPLOYED" -eq 1 ]; then
  if printf '%s' "$NOT_FOUND" | grep -q '"code":"not_found"'; then
    pass "404 trả mã chuẩn not_found"
  else
    fail "404 không đúng mã chuẩn: ${NOT_FOUND:0:160}"
  fi
  if printf '%s' "$NOT_FOUND" | grep -qiE "stack|sqlite|SELECT |INSERT INTO|D1_ERROR"; then
    fail "404 rò chi tiết nội bộ"
  else
    pass "404 không rò chi tiết nội bộ"
  fi
else
  skip "bỏ qua — Worker chưa deploy"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  printf 'KẾT QUẢ: FAIL — %s mục.\n' "$FAIL" >&2
  exit 1
fi
if [ "$DEPLOYED" -eq 0 ]; then
  printf 'KẾT QUẢ: NOT_DEPLOYED — Worker AlkCloud chưa deploy (chưa phải lỗi).\n'
  exit 0
fi
printf 'KẾT QUẢ: PASS — production khoẻ (các mục skip là do tài nguyên chưa cấu hình).\n'
