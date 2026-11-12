#!/usr/bin/env bash
# Cài 2 cron backup cho AlkCloud trên host Ubuntu.
#
# Script chỉ ghi file crontab — KHÔNG tự chạy backup, KHÔNG tự tạo bucket.
# Owner xem lại rồi tự chạy: sudo ./infra/install-backup-cron.sh
#
# Cron nằm trong crontab của user `ubuntu` (không phải root) để không cần
# sudo cho lệnh hằng ngày. Script backup trong /opt/vps-scripts/ phải giữ
# mode 750 owner root:ubuntu (không 755 — world-readable là lộ credential).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/home/ubuntu/.logs"
MARKER_BEGIN="# >>> alkcloud backup (begin)"
MARKER_END="# <<< alkcloud backup (end)"

mkdir -p "$LOG_DIR"

read -r -p "Thư mục AlkCloud [$ROOT_DIR]: " ALK_DIR
ALK_DIR="${ALK_DIR:-$ROOT_DIR}"

read -r -p "Remote TeraBox cho D1 [terabox:/backup/alkcloud]: " D1_REMOTE
D1_REMOTE="${D1_REMOTE:-terabox:/backup/alkcloud}"

read -r -p "Remote TeraBox cho B2 [terabox:/backup/alkcloud-b2]: " B2_REMOTE
B2_REMOTE="${B2_REMOTE:-terabox:/backup/alkcloud-b2}"

read -r -p "rclone remote B2 nguồn [b2alk:alkcloud]: " B2_SOURCE
B2_SOURCE="${B2_SOURCE:-b2alk:alkcloud}"

CURRENT="$(crontab -l 2>/dev/null || true)"
# Gỡ block cũ (nếu có) rồi thêm block mới ở cuối — idempotent.
CLEANED="$(printf '%s\n' "$CURRENT" | awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip { print }
')"

NEW_BLOCK="${MARKER_BEGIN}
# D1 export + upload TeraBox — 03:30 UTC
30 3 * * * cd ${ALK_DIR} && /usr/bin/node --import tsx scripts/backup-d1.ts --upload --remote ${D1_REMOTE} >> ${LOG_DIR}/alkcloud-backup.log 2>&1
# Sync B2 -> TeraBox — 04:00 UTC
0 4 * * * rclone sync ${B2_SOURCE} ${B2_REMOTE} --transfers 4 --checkers 8 --log-file ${LOG_DIR}/alkcloud-b2-sync.log
${MARKER_END}"

printf '\n%s\n\n' "$NEW_BLOCK"

printf "Ghi vào crontab cua user %s? [y/N] " "$(id -un)"
read -r CONFIRM
if [ "${CONFIRM:-n}" != "y" ] && [ "${CONFIRM:-n}" != "Y" ]; then
  echo "Đã hủy — không thay đổi crontab."
  exit 0
fi

printf '%s\n\n%s\n' "$CLEANED" "$NEW_BLOCK" | crontab -

echo "Đã cài. Kiểm tra: crontab -l"
echo
echo "Lưu ý:"
echo "  - File backup trong /opt/vps-scripts/ phải giữ mode 750 owner root:ubuntu (KHÔNG 755)."
echo "  - Script hiện KHÔNG tự xoá bản cũ — cần thêm retention sau khi owner xác nhận."
echo "  - Test thủ công trước: node --import tsx scripts/backup-d1.ts --upload"
