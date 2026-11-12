#!/usr/bin/env bash
# Kiểm tra bundle Worker có nằm trong giới hạn Workers Free hay không.
# Chỉ đọc — không deploy, không gọi API Cloudflare.
#
#   ./infra/check-worker-limits.sh
#
# Ngưỡng Workers Free (theo docs/18):
#   - Bundle nén (gzip): <= 3 MiB   (Free)
#   - Startup: 1s                    (chỉ ước lượng bằng bundle size + import count)
#   - Subrequest/request: 50         (kiểm tra tĩnh: số lời gọi storage trong 1 request)
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

echo "→ wrangler deploy --dry-run"
npx wrangler deploy --dry-run --outdir "$OUT_DIR" -c apps/api/wrangler.toml 2>&1 | tee "$OUT_DIR/dry-run.log" >/dev/null

TOTAL_LINE="$(grep -E 'Total Upload:' "$OUT_DIR/dry-run.log" | tail -1 || true)"
if [[ -z "$TOTAL_LINE" ]]; then
  echo "✗ Không đọc được 'Total Upload' từ wrangler dry-run" >&2
  tail -20 "$OUT_DIR/dry-run.log" >&2 || true
  exit 1
fi

RAW_KB="$(sed -nE 's/.*Total Upload: ([0-9.]+) KiB.*/\1/p' <<<"$TOTAL_LINE")"
GZIP_KB="$(sed -nE 's/.*gzip: ([0-9.]+) KiB.*/\1/p' <<<"$TOTAL_LINE")"

echo "  bundle thô : ${RAW_KB} KiB"
echo "  bundle gzip: ${GZIP_KB} KiB"

GZIP_LIMIT_KB=$((3 * 1024))
STATUS=0

if awk "BEGIN{exit !(${GZIP_KB} <= ${GZIP_LIMIT_KB})}"; then
  echo "✓ gzip ${GZIP_KB} KiB <= 3 MiB (Workers Free)"
else
  echo "✗ gzip ${GZIP_KB} KiB > 3 MiB — vượt giới hạn Workers Free" >&2
  STATUS=1
fi

# Cảnh báo sớm nếu gần trần (>= 75%).
if awk "BEGIN{exit !(${GZIP_KB} >= ${GZIP_LIMIT_KB} * 0.75)}"; then
  echo "⚠ bundle đã dùng >= 75% hạn mức gzip — cân nhắc code-splitting/loại dependency" >&2
fi

# Kiểm tra tĩnh: một request download chỉ gọi storage 1 lần; presign parts tối đa 20.
if grep -q "MAX_PARTS_PER_REQUEST = 20" apps/web/src/lib/upload.ts; then
  echo "✓ giới hạn presign part mỗi request = 20 (< 50 subrequest)"
else
  echo "✗ Không tìm thấy giới hạn MAX_PARTS_PER_REQUEST = 20" >&2
  STATUS=1
fi

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("node:fs");
    const src = fs.readFileSync("packages/core/src/validation.ts", "utf8");
    const match = /MAX_PART_COUNT\s*=\s*([0-9_]+)/.exec(src);
    if (!match) { console.error("✗ Không tìm thấy MAX_PART_COUNT trong packages/core/src/validation.ts"); process.exit(1); }
    const value = Number(match[1].replaceAll("_", ""));
    if (value > 10000) { console.error(`✗ MAX_PART_COUNT=${value} quá lớn`); process.exit(1); }
    console.log(`✓ MAX_PART_COUNT=${value}`);
  '
fi

exit "$STATUS"
