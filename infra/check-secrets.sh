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
# Quét **toàn bộ cây thư mục làm việc**, KHÔNG dùng `git grep`.
# Lý do: `git grep` chỉ thấy file đã track ⇒ file MỚI chưa `git add` (hay file
# trong .gitignore) chạy qua scanner ⇒ lỗ hổng thật của quality gate local.
# Bù lại: loại trừ thư mục build/dependency (chúng chứa rất nhiều chuỗi ngẫu nhiên).
#
# Allowlist DUY NHẤT: `AKIAIOSFODNN7EXAMPLE` — credential mẫu công khai của AWS
# documentation (không phải credential thật). Nếu không allowlist, mọi tài liệu
# trích dẫn ví dụ đó đều làm CI fail vĩnh viễn (đã xảy ra 1 lần).
ALLOWLIST='AKIAIOSFODNN7EXAMPLE'
HITS="$(grep -rInE '(BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[0-9A-Za-z]{36,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35})' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
  --exclude-dir=.wrangler --exclude-dir=coverage --exclude=package-lock.json \
  . 2>/dev/null | grep -vF "$ALLOWLIST" || true)"
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

# 2b. File nhạy cảm trong cây thư mục (kể cả chưa track) — phải được .gitignore.
echo "── 2b. File nhạy cảm trong cây thư mục làm việc ──"
LEAK="$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./dist -prune -o -type f \
  \( -name '.env' -o -name '.env.local' -o -name '.env.production' -o -name '.env.staging' \
     -o -name 'credentials.json' -o -name 'id_rsa' -o -name '*.pem' -o -name '*.key' \
     -o -name '*.p12' -o -name '*.pfx' -o -name 'forwarding.secret' \) -print 2>/dev/null || true)"
LEAK_TRACKED=""
if [ -n "$LEAK" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      LEAK_TRACKED="$LEAK_TRACKED\n$f"
    fi
  done <<EOF
$LEAK
EOF
fi
if [ -n "$LEAK_TRACKED" ]; then
  fail "file nhạy cảm bị track (lặp lại check 2 — xem trên):"
  printf '%b\n' "$LEAK_TRACKED" | cut -d: -f1 >&2
elif [ -n "$LEAK" ]; then
  pass "file nhạy cảm chỉ tồn tại local (không bị track)"
else
  pass "không có file nhạy cảm nào trong cây thư mục"
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
