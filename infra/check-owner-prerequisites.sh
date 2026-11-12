#!/usr/bin/env bash
# AlkCloud — kiểm tra toàn bộ điều kiện tiên quyết trước khi owner setup production.
#
# Usage:
#   ./infra/check-owner-prerequisites.sh
#
# Dependencies: bash, curl, python3, npx (wrangler trong repo).
# Expected output: tổng hợp theo nhóm với trạng thái PASS / FAIL / NOT_CONFIGURED /
#                 PERMISSION_DENIED / SKIPPED, rồi checklist còn lại.
# Exit code: 0 = không có FAIL, 1 = có FAIL (chưa sẵn sàng), 2 = thiếu dependency.
#
# SAFETY:
# - Read-only 100%: chỉ đọc trạng thái local + API GET. KHÔNG deploy, KHÔNG tạo
#   tài nguyên, KHÔNG sửa DNS/D1/secret.
# - KHÔNG in secret ra terminal, KHÔNG ghi secret vào file log.

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL_COUNT=0
BLOCKED_COUNT=0

run_check() {
  local title="$1" script="$2"
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo "▶ $title"
  echo "──────────────────────────────────────────────────────────────"
  if [ ! -x "$script" ]; then
    echo "SKIPPED           $title — script không tồn tại: $script"
    BLOCKED_COUNT=$((BLOCKED_COUNT+1))
    return 0
  fi
  local out rc
  out="$("$script" 2>&1)"; rc=$?
  printf '%s\n' "$out"
  if [ $rc -eq 1 ]; then FAIL_COUNT=$((FAIL_COUNT+1)); fi
  return 0
}

echo "== AlkCloud — kiểm tra điều kiện tiên quyết (read-only) =="
echo "Thời điểm: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

run_check "Cloudflare API token (B4)" ./infra/check-cloudflare-token.sh
run_check "Backblaze B2 (B3)" ./infra/check-b2.sh
run_check "Cloudflare D1 (B6)" ./infra/check-d1.sh
run_check "DNS & routing (B7)" ./infra/check-dns.sh
run_check "Gói deployment (static)" ./infra/check-deployment.sh

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "▶ Build & test (local)"
echo "──────────────────────────────────────────────────────────────"
if [ "${ALKCLOUD_SKIP_BUILD:-0}" = "1" ]; then
  echo "SKIPPED           build — ALKCLOUD_SKIP_BUILD=1"
else
  if npm run --silent typecheck >/dev/null 2>&1; then
    echo "PASS              typecheck"
  else
    echo "FAIL              typecheck"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
  if npm test --silent >/tmp/alkcloud-prereq-test.log 2>&1; then
    echo "PASS              test ($(grep -m1 -E '^# pass' /tmp/alkcloud-prereq-test.log | tr -s ' ' ' '))"
  else
    echo "FAIL              test — xem /tmp/alkcloud-prereq-test.log"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
  rm -f /tmp/alkcloud-prereq-test.log
fi

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "▶ Checklist còn lại (cần OWNER)"
echo "──────────────────────────────────────────────────────────────"
cat <<'EOF'
[B3] Backblaze B2 : tạo bucket riêng + app key giới hạn theo bucket     → docs/20-OWNER-SETUP.md §B3
[B4] Token CF     : token có Account Analytics:Read (không cần Edit)     → docs/20-OWNER-SETUP.md §B4
[B6] D1 production: wrangler d1 create alkcloud + cập nhật database_id    → docs/20-OWNER-SETUP.md §B6
[B7] DNS          : CNAME cloud.alk.xx.kg → <worker>.workers.dev          → docs/20-OWNER-SETUP.md §B7
[SEC] Secrets     : AUTH_PEPPER, BOOTSTRAP_SETUP_TOKEN, B2_* (8 secret)   → docs/20-OWNER-SETUP.md §S1
EOF

echo ""
if [ "$FAIL_COUNT" -gt 0 ]; then
  printf 'KẾT QUẢ: CHƯA SẴN SÀNG — %s nhóm có FAIL.\n' "$FAIL_COUNT"
  exit 1
fi
printf 'KẾT QUẢ: không có FAIL cục bộ (vẫn còn blocker phụ thuộc tài nguyên thật).\n'
exit 0
