#!/usr/bin/env bash
# AlkCloud — verify:all (Phase 3).
#
#   ./infra/verify-all.sh
#
# Chạy toàn bộ kiểm tra CHẾT ĐỊNH (không phụ thuộc tài nguyên bên ngoài) và
# phân loại kết quả thành 4 mức:
#
#   PASS     — kiểm tra chạy và đạt
#   FAIL     — kiểm tra chạy và KHÔNG đạt ⇒ CI đỏ
#   SKIP     — kiểm tra cần tài nguyên thật, chưa cấu hình ⇒ KHÔNG phải xanh
#   BLOCKED  — phụ thuộc tài nguyên bị chặn (B3/B4/B6/B7) ⇒ KHÔNG phải xanh
#
# Exit code:
#   0 — tất cả PASS (có thể có SKIP/BLOCKED nếu chạy `--allow-skip`)
#   1 — có FAIL
#   2 — có BLOCKED hoặc SKIP (mặc định) ⇒ KHÔNG được coi là đạt
#
# Usage:
#   ./infra/verify-all.sh                 # nghiêm ngặt: SKIP/BLOCKED ⇒ exit 2
#   ./infra/verify-all.sh --allow-skip    # cho phép SKIP/BLOCKED (exit 0 nếu không FAIL)
set -uo pipefail
cd "$(dirname "$0")/.."

ALLOW_SKIP=0
[ "${1:-}" = "--allow-skip" ] && ALLOW_SKIP=1

PASS=0; FAIL=0; SKIP=0; BLOCKED=0
LOG_DIR="/tmp/alkcloud-verify-$$"
mkdir -p "$LOG_DIR"
trap 'rm -rf "$LOG_DIR"' EXIT

banner() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
mark_pass()    { PASS=$((PASS+1));    printf '  \033[32mPASS\033[0m     %s\n' "$1"; }
mark_fail()    { FAIL=$((FAIL+1));    printf '  \033[31mFAIL\033[0m     %s\n' "$1"; }
mark_skip()    { SKIP=$((SKIP+1));    printf '  \033[33mSKIP\033[0m     %s\n' "$1"; }
mark_blocked() { BLOCKED=$((BLOCKED+1)); printf '  \033[35mBLOCKED\033[0m  %s\n' "$1"; }

run() {
  # run <tên> <lệnh>   — PASS nếu exit 0
  local name="$1"; shift
  local log="$LOG_DIR/$(echo "$name" | tr ' /' '__').log"
  if "$@" >"$log" 2>&1; then
    mark_pass "$name"
  else
    mark_fail "$name"
    sed -n '1,12p' "$log" | sed 's/^/      /'
  fi
}

# ---------------------------------------------------------------- 1. Tĩnh
banner "1. Kiểm tra tĩnh (không phụ thuộc tài nguyên ngoài)"
run "typecheck"           npm run --silent typecheck
run "unit test"           npm test
run "security test"       npm run --silent test:security
run "build (api + web)"   npm run --silent build
run "worker limits"       ./infra/check-worker-limits.sh
run "deployment (tĩnh)"  ./infra/check-deployment.sh
run "log safety"          ./infra/check-log-safety.sh
run "quota audit"         npm run --silent audit:quota

# ---------------------------------------------------------------- 2. Tích hợp
banner "2. Kiểm tra tích hợp (cần tài nguyên thật)"
if [[ -n "${ALKCLOUD_TEST_B2_ENDPOINT:-}" && -n "${ALKCLOUD_TEST_B2_KEY_ID:-}" && -n "${ALKCLOUD_TEST_B2_APP_KEY:-}" ]]; then
  run "integration test (B2)" npm run --silent test:integration
else
  mark_skip "integration test (B2) — thiếu ALKCLOUD_TEST_B2_*"
fi

# ---------------------------------------------------------------- 3. Tài nguyên
banner "3. Kiểm tra tài nguyên (owner phải cấu hình)"
# Quy ước exit code của infra/check-*.sh:
#   0 = PASS, 1 = FAIL, 2 = BLOCKED (NOT_CONFIGURED/PERMISSION_DENIED),
#   3 = SKIP, 4 = thiếu dependency
run_resource() {
  local name="$1"; shift
  local log="$LOG_DIR/$(echo "$name" | tr ' /' '__').log"
  "$@" >"$log" 2>&1
  local rc=$?
  case "$rc" in
    0) mark_pass "$name" ;;
    1) mark_fail "$name"; sed -n '1,6p' "$log" | sed 's/^/      /' ;;
    2) mark_blocked "$name"; sed -n '1,6p' "$log" | sed 's/^/      /' ;;
    3) mark_skip "$name"; sed -n '1,4p' "$log" | sed 's/^/      /' ;;
    *) mark_skip "$name (rc=$rc — thiếu dependency)"; sed -n '1,4p' "$log" | sed 's/^/      /' ;;
  esac
}

if [[ -f apps/api/wrangler.toml ]] && grep -q 'REPLACE_WITH_D1_DATABASE_ID' apps/api/wrangler.toml; then
  mark_blocked "D1 production — database_id còn placeholder (B6)"
else
  run_resource "D1 production" ./infra/check-d1.sh --remote
fi

if [[ -n "${ALKCLOUD_TEST_B2_ENDPOINT:-}" && -n "${ALKCLOUD_TEST_B2_APP_KEY:-}" ]]; then
  run_resource "B2 bucket + key" ./infra/check-b2.sh
else
  mark_blocked "B2 bucket + key — chưa có credential (B3)"
fi

if [[ -n "${CF_API_TOKEN:-}" || -r /home/ubuntu/.cloudflare/token ]]; then
  run_resource "Cloudflare token (analytics read)" ./infra/check-cloudflare-token.sh
else
  mark_blocked "Cloudflare token — chưa có token (B4)"
fi

run_resource "DNS cloud.alk.xx.kg" ./infra/check-dns.sh

if ./infra/check-production-health.sh >"$LOG_DIR/health.log" 2>&1; then
  if grep -q 'NOT_DEPLOYED' "$LOG_DIR/health.log"; then
    mark_skip "production health — Worker chưa deploy"
  else
    mark_pass "production health"
  fi
else
  mark_fail "production health"
  sed -n '1,8p' "$LOG_DIR/health.log" | sed 's/^/      /'
fi

# ---------------------------------------------------------------- 4. E2E
banner "4. E2E production"
if [[ -n "${ALKCLOUD_E2E_API_URL:-}" && -n "${ALKCLOUD_E2E_AUTH_KEY:-}" ]]; then
  if npm run --silent test:e2e >"$LOG_DIR/e2e.log" 2>&1; then
    mark_pass "E2E production"
  else
    mark_fail "E2E production"
    sed -n '1,20p' "$LOG_DIR/e2e.log" | sed 's/^/      /'
  fi
else
  mark_skip "E2E production — thiếu ALKCLOUD_E2E_API_URL / ALKCLOUD_E2E_AUTH_KEY"
fi

# ---------------------------------------------------------------- Tổng kết
banner "Tổng kết"
printf '  PASS=%s  FAIL=%s  SKIP=%s  BLOCKED=%s\n' "$PASS" "$FAIL" "$SKIP" "$BLOCKED"
printf '  Quy tắc: SKIP/BLOCKED KHÔNG được tính là PASS.\n\n'

if [ "$FAIL" -gt 0 ]; then
  printf 'KẾT QUẢ: FAIL — %s mục thất bại.\n' "$FAIL" >&2
  exit 1
fi
if [ "$SKIP" -gt 0 ] || [ "$BLOCKED" -gt 0 ]; then
  if [ "$ALLOW_SKIP" -eq 1 ]; then
    printf 'KẾT QUẢ: PASS (--allow-skip) — %s SKIP, %s BLOCKED cần owner xử lý.\n' "$SKIP" "$BLOCKED" >&2
    exit 0
  fi
  printf 'KẾT QUẢ: CHƯA ĐẠT — %s SKIP, %s BLOCKED (chưa cấu hình tài nguyên thật).\n' "$SKIP" "$BLOCKED" >&2
  exit 2
fi
printf 'KẾT QUẢ: PASS — toàn bộ kiểm tra đạt.\n'
