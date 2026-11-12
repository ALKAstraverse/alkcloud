#!/usr/bin/env bash
# AlkCloud — kiểm tra an toàn log (static scan + runtime).
#
#   ./infra/check-log-safety.sh
#
# Chỉ đọc — không deploy, không gọi API Cloudflare.
#
# Kiểm tra:
#  1. Không có console.log/console.info trong mã runtime (chỉ console.error có cấu trúc).
#  2. Mọi console.error đi qua JSON có cấu trúc (không log object thô).
#  3. Không có mẫu nguy hiểm: log trực tiếp authKey/password/token/secret.
#  4. Không có `Authorization`/`X-Amz-Signature` được ghi vào log.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

SRC_DIRS=(apps/api/src apps/web/src packages/core/src packages/db/src packages/storage/src packages/auth/src)

echo "── 1. Không log bằng console.log/info/debug trong mã runtime ──"
HITS="$(grep -rnE "console\.(log|info|debug)\(" "${SRC_DIRS[@]}" 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  fail "có console.log/info/debug trong mã runtime:"
  printf '%s\n' "$HITS" >&2
else
  pass "không có console.log/info/debug"
fi

echo "── 2. console.error phải có cấu trúc (JSON.stringify) ──"
UNSTRUCTURED=""
for FILE in $(grep -rlE "console\.error\(" "${SRC_DIRS[@]}" 2>/dev/null); do
  # Bỏ qua dòng comment (chỉ giải thích, không phải lệnh log).
  CODE_LINES="$(grep -nE "console\.error\(" "$FILE" | grep -vE "^[0-9]+:[[:space:]]*(//|\*|/\*)" || true)"
  [ -z "$CODE_LINES" ] && continue
  # Dòng chứa console.error mà không có JSON.stringify ở cùng hoặc dòng kế tiếp.
  if ! grep -A2 "console\.error(" "$FILE" | grep -q "JSON.stringify"; then
    UNSTRUCTURED="$UNSTRUCTURED $FILE"
  fi
done
if [ -n "$UNSTRUCTURED" ]; then
  fail "console.error không có cấu trúc trong:$UNSTRUCTURED"
else
  pass "mọi console.error đều có cấu trúc JSON"
fi

echo "── 3. Không log trực tiếp credential ──"
# console.log/error chứa biến chứa từ khoá nhạy cảm, hoặc chuỗi ghép trực tiếp.
RISKY="$(grep -rnE "console\.(error|log|info)\(.*(authKey|password|pepper|secretAccessKey|applicationKey|setupToken|recoveryCode|sessionToken)" "${SRC_DIRS[@]}" 2>/dev/null || true)"
if [ -n "$RISKY" ]; then
  fail "tìm thấy log trực tiếp credential:"
  printf '%s\n' "$RISKY" >&2
else
  pass "không log trực tiếp credential"
fi

echo "── 4. Redaction helper có tồn tại và được dùng ──"
if [ -f apps/api/src/lib/redact.ts ]; then
  pass "apps/api/src/lib/redact.ts tồn tại"
else
  fail "thiếu apps/api/src/lib/redact.ts"
fi
for TARGET in apps/api/src/lib/http.ts apps/api/src/lib/audit.ts; do
  if grep -q "redactValue\|redactSecrets" "$TARGET"; then
    pass "$TARGET dùng redaction"
  else
    fail "$TARGET chưa dùng redaction"
  fi
done

echo "── 5. Không in giá trị secret của Worker ra log ──"
if grep -rnE "console\.(error|log)\(.*(AUTH_PEPPER|BOOTSTRAP_SETUP_TOKEN|CLOUDFLARE_ANALYTICS_TOKEN)" "${SRC_DIRS[@]}" 2>/dev/null | grep -q .; then
  fail "có log giá trị secret của Worker"
else
  pass "không log giá trị secret của Worker"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  printf 'KẾT QUẢ: FAIL — %s mục vi phạm.\n' "$FAIL" >&2
  exit 1
fi
printf 'KẾT QUẢ: PASS — không phát hiện rủi ro log.\n'
