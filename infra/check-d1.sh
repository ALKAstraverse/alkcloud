#!/usr/bin/env bash
# AlkCloud — kiểm tra D1 (READ-ONLY, KHÔNG chạy migration).
#
# Usage:
#   ./infra/check-d1.sh              # kiểm tra local state (wrangler --local)
#   ./infra/check-d1.sh --remote     # kiểm tra D1 production (read-only)
#
# Dependencies: npx wrangler (đã cài trong repo), python3.
# Expected output: mỗi dòng "<STATUS> <check> — <chi tiết>".
# Exit code: 0 = tất cả PASS, 1 = có FAIL, 2 = NOT_CONFIGURED/PERMISSION_DENIED,
#            3 = chỉ SKIPPED, 4 = thiếu dependency.
#
# SAFETY:
# - Chỉ đọc: `wrangler d1 execute <db> --command "SELECT ..."` (không `--file`,
#   không `--remote` khi chưa được yêu cầu rõ ràng).
# - KHÔNG chạy migration, KHÔNG ghi/xoá dữ liệu.
# - `--remote` chỉ đọc bảng `_migrations` và `sqlite_master`.

set -uo pipefail

PASS=0; FAIL=0; NOT_CONFIGURED=0; PERMISSION_DENIED=0; SKIPPED=0
ok()     { printf 'PASS              %s — %s\n' "$1" "$2"; PASS=$((PASS+1)); }
fail()   { printf 'FAIL              %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
nc()     { printf 'NOT_CONFIGURED    %s — %s\n' "$1" "$2"; NOT_CONFIGURED=$((NOT_CONFIGURED+1)); }
denied() { printf 'PERMISSION_DENIED %s — %s\n' "$1" "$2"; PERMISSION_DENIED=$((PERMISSION_DENIED+1)); }
skip()   { printf 'SKIPPED           %s — %s\n' "$1" "$2"; SKIPPED=$((SKIPPED+1)); }

cd "$(dirname "$0")/.."
. infra/lib/cf-token.sh
alkcloud_cf_init || true
command -v python3 >/dev/null 2>&1 || { echo "FAIL — thiếu python3"; exit 4; }
command -v npx >/dev/null 2>&1 || { echo "FAIL — thiếu npx"; exit 4; }

REMOTE=0
[ "${1:-}" = "--remote" ] && REMOTE=1

WRANGLER="apps/api/wrangler.toml"
DB_NAME="$(sed -nE 's/^database_name[[:space:]]*=[[:space:]]*"([^"]+)"/\1/p' "$WRANGLER" | head -1)"
DB_ID="$(sed -nE 's/^database_id[[:space:]]*=[[:space:]]*"([^"]+)"/\1/p' "$WRANGLER" | head -1)"

printf '== D1 (%s) ==\n' "$([ $REMOTE -eq 1 ] && echo 'REMOTE' || echo 'LOCAL')"

if [ -z "$DB_NAME" ] || [ -z "$DB_ID" ]; then
  fail "wrangler-config" "không đọc được database_name/database_id từ $WRANGLER"
elif [[ "$DB_ID" == REPLACE_WITH* ]]; then
  # Placeholder chỉ là BLOCKED cho production. Local D1 chạy bằng state file,
  # không cần database_id thật ⇒ local vẫn kiểm tra được schema.
  if [ $REMOTE -eq 1 ]; then
    fail "database_id" "còn placeholder ($DB_ID) — cần 'wrangler d1 create $DB_NAME' (docs/20 §B6)"
  else
    nc "database_id" "còn placeholder — OK cho local, cần cho production (B6)"
  fi
else
  ok "database_id" "đã cấu hình ($DB_ID)"
fi

SCOPE="--local"
[ $REMOTE -eq 1 ] && SCOPE="--remote"

QUERY="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
OUT="$(npx wrangler -c "$WRANGLER" d1 execute "$DB_NAME" $SCOPE --json --command "$QUERY" 2>&1)"
RC=$?
if [ $RC -ne 0 ]; then
  if printf '%s' "$OUT" | grep -qiE 'permission|unauthorized|forbidden|authentication'; then
    denied "d1-read" "token thiếu quyền đọc D1"
  elif [ $REMOTE -eq 1 ] && printf '%s' "$OUT" | grep -qiE 'not found|database_id|invalid'; then
    fail "d1-read" "không tìm thấy database production — chưa tạo hoặc sai id"
  else
    fail "d1-read" "lệnh đọc D1 thất bại (rc=$RC): $(printf '%s' "$OUT" | head -3 | tr '\n' ' ' | cut -c1-160)"
  fi
else
  TABLES="$(printf '%s' "$OUT" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    names=[]
    for item in d:
        for row in (item.get("results") or []):
            if row.get("name"): names.append(row["name"])
    print(",".join(names))
except Exception:
    print("")' 2>/dev/null)"
  if [ -z "$TABLES" ]; then
    nc "d1-schema" "database có 0 bảng — chưa chạy migration (docs/21-PRODUCTION-MIGRATION.md)"
  else
    ok "d1-schema" "$(printf '%s' "$TABLES" | tr ',' '\n' | wc -l) bảng: $(printf '%s' "$TABLES" | cut -c1-140)"
  fi
  for required in files folders shares sessions audit_logs; do
    case ",$TABLES," in
      *",$required,"*) ok "table:$required" "có" ;;
      *) [ $REMOTE -eq 1 ] && fail "table:$required" "thiếu bảng — migration chưa chạy đầy đủ" || nc "table:$required" "thiếu (local chưa migrate)" ;;
    esac
  done
  MIG="$(npx wrangler -c "$WRANGLER" d1 execute "$DB_NAME" $SCOPE --json --command "SELECT version FROM _migrations ORDER BY version" 2>/dev/null | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(",".join(str(r.get("version")) for item in d for r in (item.get("results") or [])))
except Exception:
    print("")' 2>/dev/null)"
  if [ -n "$MIG" ]; then
    ok "migrations-applied" "version đã áp dụng: $MIG"
  else
    nc "migrations-applied" "bảng _migrations trống hoặc không tồn tại"
  fi
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
