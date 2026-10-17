#!/usr/bin/env bash
set -euo pipefail

# Run from any working directory. Stop the server with Ctrl+C.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo 'cargo-watch is required. Install it with: cargo install cargo-watch --locked' >&2
  exit 1
fi

if [[ ! -d web/node_modules ]]; then
  npm --prefix web ci
fi
npm --prefix web run build

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
  cd web
  exec node node_modules/vite/bin/vite.js build --watch
) &
watch_pids+=("$!")

# Override these environment variables to use another recording directory/port.
cargo watch --ignore 'web/**' -- cargo run --release -- \
  --data-dir "${MCAP_DATA_DIR:-$HOME/repos/eduidl/mcapdecode-rs/data}" \
  --listen "${HAHN_LISTEN:-127.0.0.1:3000}" \
  "$@" &
watch_pids+=("$!")

# Stop both watchers if either one exits.
wait -n "${watch_pids[@]}"
