#!/usr/bin/env bash
# AlkCloud — kiểm tra cấu hình Backblaze B2 (READ-ONLY, KHÔNG tạo tài nguyên).
#
# Usage:
#   ./infra/check-b2.sh
#   ALKCLOUD_TEST_B2_ENDPOINT=... ALKCLOUD_TEST_B2_REGION=... \
#   ALKCLOUD_TEST_B2_BUCKET=... ALKCLOUD_TEST_B2_KEY_ID=... \
#   ALKCLOUD_TEST_B2_APP_KEY=... ./infra/check-b2.sh
#
# Dependencies: curl, python3. Không cần rclone/wrangler.
# Expected output: mỗi dòng "<STATUS> <check> — <chi tiết>".
# Exit code: 0 = không FAIL, 1 = có FAIL, 2 = thiếu dependency.
#
# SAFETY:
# - Chỉ đọc (ListBuckets / ListObjects với prefix test). KHÔNG tạo/xoá bucket,
#   KHÔNG tạo app key, KHÔNG xoá object.
# - KHÔNG in app key ra terminal; chỉ in 4 ký tự cuối để đối chiếu.
# - KHÔNG ghi credential vào file log.
#
# Lưu ý: Backblaze B2 không có API "list buckets" cho app key chỉ giới hạn theo
# bucket (key có bucketId ⇒ không thấy bucket khác). Với key giới hạn bucket,
# endpoint list-buckets trả rỗng — đó là hành vi ĐÚNG, không phải lỗi.

set -uo pipefail

PASS=0; FAIL=0; NOT_CONFIGURED=0; PERMISSION_DENIED=0; SKIPPED=0
ok()     { printf 'PASS              %s — %s\n' "$1" "$2"; PASS=$((PASS+1)); }
fail()   { printf 'FAIL              %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
nc()     { printf 'NOT_CONFIGURED    %s — %s\n' "$1" "$2"; NOT_CONFIGURED=$((NOT_CONFIGURED+1)); }
denied() { printf 'PERMISSION_DENIED %s — %s\n' "$1" "$2"; PERMISSION_DENIED=$((PERMISSION_DENIED+1)); }
skip()   { printf 'SKIPPED           %s — %s\n' "$1" "$2"; SKIPPED=$((SKIPPED+1)); }

command -v curl >/dev/null 2>&1 || { echo "FAIL — thiếu curl"; exit 4; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL — thiếu python3"; exit 4; }

ENDPOINT="${ALKCLOUD_TEST_B2_ENDPOINT:-${B2_ENDPOINT:-}}"
REGION="${ALKCLOUD_TEST_B2_REGION:-${B2_REGION:-}}"
BUCKET="${ALKCLOUD_TEST_B2_BUCKET:-${B2_BUCKET:-}}"
KEY_ID="${ALKCLOUD_TEST_B2_KEY_ID:-${B2_ACCESS_KEY_ID:-}}"
APP_KEY="${ALKCLOUD_TEST_B2_APP_KEY:-${B2_SECRET_ACCESS_KEY:-}}"
# Maintenance key (dùng cho backup/list version) — tuỳ chọn.
MAINT_KEY_ID="${B2_MAINTENANCE_ACCESS_KEY_ID:-}"
MAINT_APP_KEY="${B2_MAINTENANCE_SECRET_ACCESS_KEY:-}"

printf '== Backblaze B2 (read-only) ==\n'

for pair in "ENDPOINT:$ENDPOINT" "REGION:$REGION" "BUCKET:$BUCKET" "KEY_ID:$KEY_ID" "APP_KEY:$APP_KEY"; do
  name="${pair%%:*}"; value="${pair#*:}"
  if [ -z "$value" ]; then nc "$name" "chưa cấu hình ($name)"; else ok "$name" "đã cấu hình"; fi
done

if [ -z "$ENDPOINT" ] || [ -z "$BUCKET" ] || [ -z "$KEY_ID" ] || [ -z "$APP_KEY" ]; then
  printf '\nTổng kết: PASS=%s FAIL=%s NOT_CONFIGURED=%s PERMISSION_DENIED=%s SKIPPED=%s\n' \
    "$PASS" "$FAIL" "$NOT_CONFIGURED" "$PERMISSION_DENIED" "$SKIPPED"
  echo "Gợi ý: xem docs/20-OWNER-SETUP.md §B3 để tạo bucket + app key giới hạn theo bucket."
  # Chưa cấu hình ⇒ BLOCKED (2), KHÔNG phải PASS.
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
  if [ "$NOT_CONFIGURED" -gt 0 ] || [ "$PERMISSION_DENIED" -gt 0 ]; then exit 2; fi
  exit 3
fi

# B2 API dùng chữ ký HMAC-SHA256 — không thể gọi bằng curl đơn giản mà không ký.
# Vì vậy ta dùng SDK đã cài trong repo (packages/storage) để kiểm tra read-only.
KEY_MASK="...${KEY_ID: -4}"
ok "key_mask" "key id hiển thị dạng ${KEY_MASK}"

B2_CHECK="$(node --import tsx .probe/b2-check.mts 2>&1)"
B2_RC=$?
printf '%s\n' "$B2_CHECK" | sed 's/^/  /'
case "$B2_RC" in
  0) ok "b2-read" "đọc bucket thành công (xem chi tiết ở trên)" ;;
  3) denied "b2-read" "app key không có quyền đọc bucket" ;;
  4) fail "b2-read" "lỗi xác thực B2 (endpoint/key sai)" ;;
  *) fail "b2-read" "không kiểm tra được B2 (rc=${B2_RC})" ;;
esac

if [ -n "$MAINT_KEY_ID" ] && [ -n "$MAINT_APP_KEY" ]; then
  ok "maintenance-key" "đã cấu hình key maintenance (dùng cho backup/list version)"
else
  nc "maintenance-key" "chưa có key maintenance (backup B2 qua rclone sẽ không chạy được)"
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
