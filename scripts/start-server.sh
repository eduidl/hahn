#!/usr/bin/env bash
set -euo pipefail

# Run from any working directory. Stop the server with Ctrl+C.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo 'cargo-watch is required. Install it with: cargo install cargo-watch --locked' >&2
  exit 1
fi

if [[ ! -d client/node_modules ]]; then
  npm --prefix client ci
fi
npm --prefix client run build

# The IANA name of this machine's timezone, if it can be determined.
local_timezone() {
  if [[ -n "${TZ:-}" ]]; then
    echo "${TZ#:}"
  elif command -v timedatectl >/dev/null 2>&1 \
    && timedatectl show --property=Timezone --value 2>/dev/null | grep -q .; then
    timedatectl show --property=Timezone --value
  elif [[ -s /etc/timezone ]]; then
    cat /etc/timezone
  elif [[ -L /etc/localtime ]]; then
    readlink /etc/localtime | sed 's|.*/zoneinfo/||'
  fi
}

# Override with HAHN_TIMEZONE; an empty value declares no timezone.
timezone="${HAHN_TIMEZONE-$(local_timezone)}"
timezone_args=()
if [[ -n "$timezone" ]]; then
  timezone_args=(--timezone "$timezone")
fi

watch_pids=()
cleanup() {
  trap - EXIT INT TERM
  kill "${watch_pids[@]}" 2>/dev/null || true
  wait "${watch_pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep the files served on the same port up to date.
(
  cd client
  exec node node_modules/vite/bin/vite.js build --watch
) &
watch_pids+=("$!")

# Override these environment variables to use another recording directory/port.
# Recordings are inputs, so changes under data/ do not restart the server.
cargo watch --ignore 'web/**' --ignore 'data/**' -- cargo run --release -- \
  --data-dir "${HAHN_DATA_DIR:-${MCAP_DATA_DIR:-$project_dir/data}}" \
  --listen "${HAHN_LISTEN:-127.0.0.1:3000}" \
  "${timezone_args[@]}" \
  "$@" &
watch_pids+=("$!")

# Stop both watchers if either one exits.
wait -n "${watch_pids[@]}"
