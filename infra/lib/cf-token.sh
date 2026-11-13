#!/usr/bin/env bash
# AlkCloud — nạp Cloudflare token từ nhiều nguồn (KHÔNG in giá trị).
#
# Thứ tự ưu tiên:
#   1. $CF_API_TOKEN          (biến môi trường)
#   2. $CLOUDFLARE_API_TOKEN  (biến chuẩn của wrangler)
#   3. $CF_API_TOKEN_FILE     (file chứa CF_API_TOKEN=... hoặc token thô)
#   4. /home/ubuntu/.cloudflare/apikey  (nhiều token, chọn theo $CF_TOKEN_LABEL)
#   5. /home/ubuntu/.cloudflare/token   (token cũ, 1 token)
#
# Token ĐƯỢC export thành CLOUDFLARE_API_TOKEN để `wrangler` dùng được
# (token nằm trong env của process con, KHÔNG nằm trong argv ⇒ không lộ qua
# process list).
#
# $CF_TOKEN_LABEL — nhãn trong file apikey (mặc định "Edit Workers Scripts and D1").
# $CF_ACCOUNT    — Cloudflare account id (mặc định account của owner).

CF_ACCOUNT_DEFAULT="c3f46654371899594a8ddf59b863d211"
CF_TOKEN_LABEL_DEFAULT="Edit Workers Scripts and D1"

alkcloud_load_cf_token() {
  local token="" label="${CF_TOKEN_LABEL:-$CF_TOKEN_LABEL_DEFAULT}"

  if [ -n "${CF_API_TOKEN:-}" ]; then
    token="$CF_API_TOKEN"
  elif [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    token="$CLOUDFLARE_API_TOKEN"
  elif [ -n "${CF_API_TOKEN_FILE:-}" ] && [ -r "${CF_API_TOKEN_FILE}" ]; then
    token="$(grep -m1 -E '^CF_API_TOKEN=' "$CF_API_TOKEN_FILE" | cut -d= -f2- | tr -d '\r\n')"
    [ -z "$token" ] && token="$(tr -d '\r\n' < "$CF_API_TOKEN_FILE")"
  elif [ -r /home/ubuntu/.cloudflare/apikey ]; then
    token="$(grep -m1 "^${label}:" /home/ubuntu/.cloudflare/apikey | cut -d: -f2- | tr -d '\r\n ')"
  fi

  if [ -z "$token" ] && [ -r /home/ubuntu/.cloudflare/token ]; then
    token="$(grep -m1 '^CF_API_TOKEN=' /home/ubuntu/.cloudflare/token | cut -d= -f2- | tr -d '\r\n')"
  fi

  printf '%s' "$token"
}

# Nạp token theo NHÃN cụ thể trong file apikey (bỏ qua biến môi trường).
# Dùng khi mỗi quyền cần một token riêng (VD: analytics read ≠ dns read).
#   alkcloud_load_cf_token_by_label "Edit Zone DNS"
alkcloud_load_cf_token_by_label() {
  local label="$1" token=""
  [ -z "$label" ] && return 0
  [ -r /home/ubuntu/.cloudflare/apikey ] || return 0
  token="$(grep -m1 "^${label}:" /home/ubuntu/.cloudflare/apikey | cut -d: -f2- | tr -d '\r\n ')"
  printf '%s' "$token"
}

# Nạp + export. Gọi ở đầu script kiểm tra:
#   . "$(dirname "$0")/lib/cf-token.sh"
#   alkcloud_cf_init || true
alkcloud_cf_init() {
  local token
  token="$(alkcloud_load_cf_token)"
  [ -z "$token" ] && return 1
  export CLOUDFLARE_API_TOKEN="$token"
  export CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT:-$CF_ACCOUNT_DEFAULT}"
  export CF_API_TOKEN="$token"
  return 0
}
