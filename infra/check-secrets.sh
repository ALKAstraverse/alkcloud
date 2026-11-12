#!/usr/bin/env bash
# AlkCloud — quét secret & file nhạy cảm (WS-J).
#
#   ./infra/check-secrets.sh
#
# Chỉ đọc — không sửa file, không gọi API.
#
# Quy tắc: KHÔNG in nội dung khớp ra log (chỉ tên file + số dòng) để tránh
# làm lộ secret trong CI log.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

echo "── 1. Mẫu secret kinh điển trong mã nguồn ──"
HITS="$(git grep -nIE '(BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[0-9A-Za-z]{36,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35})' -- . ':!package-lock.json' 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  fail "phát hiện mẫu secret (chỉ hiện file:dòng, KHÔNG in nội dung):"
  echo "$HITS" | cut -d: -f1,2 >&2
else
  pass "không có mẫu secret"
fi

echo "── 2. File nhạy cảm bị commit ──"
BAD="$(git ls-files | grep -E '(^|/)\.env$|\.env\.(local|production|staging)$|credentials\.json$|id_rsa|\.pem$|\.key$|\.p12$|\.pfx$|forwarding\.secret' || true)"
if [ -n "$BAD" ]; then
  fail "file nhạy cảm đang được track:"; echo "$BAD" >&2
else
  pass "không có file nhạy cảm bị track"
fi

echo "── 3. Giá trị secret của Worker không nằm trong mã nguồn ──"
HITS="$(git grep -nIE '(AUTH_PEPPER|BOOTSTRAP_SETUP_TOKEN|CLOUDFLARE_ANALYTICS_TOKEN|B2_SECRET_ACCESS_KEY)\s*=\s*["'"'"'][^"'"'"']{8,}' -- . ':!*.example' ':!.env.example' ':!docs/*' 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  fail "phát hiện giá trị secret gán trực tiếp:"
  echo "$HITS" | cut -d: -f1,2 >&2
else
  pass "không có giá trị secret gán trực tiếp"
fi

echo "── 4. .env.example: biến secret phải là placeholder ──"
# CHỈ kiểm tra biến có tên giống SECRET. URL/hạn mức/số là cấu hình công khai
# ⇒ không phải secret (kiểm tra mọi biến sẽ báo nhầm hàng loạt).
if [ -f .env.example ]; then
  BAD="$(grep -nE '^[A-Z0-9_]*(SECRET|TOKEN|PEPPER|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=.+' .env.example | grep -vE '=(REPLACE|CHANGE|your-|<|xxx|placeholder|example|CHANGE_ME|$)' || true)"
  if [ -n "$BAD" ]; then
    fail ".env.example có biến secret chứa giá trị thật:"; echo "$BAD" >&2
  else
    pass "biến secret trong .env.example đều là placeholder"
  fi
else
  fail "thiếu .env.example"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  printf 'KẾT QUẢ: FAIL — %s mục vi phạm.\n' "$FAIL" >&2
  exit 1
fi
printf 'KẾT QUẢ: PASS — không phát hiện secret.\n'
