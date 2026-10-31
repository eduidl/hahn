#!/usr/bin/env bash
# Runs the current contract against synthetic recordings on a spare port.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${CONFORMANCE_PORT:-3918}"
cargo build --manifest-path server/Cargo.toml --quiet --locked --bins --examples
fixtures="$(mktemp -d)"
server=""
cleanup() {
  result=$?
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  if (( result != 0 )); then
    cat "$fixtures/server.log" 2>/dev/null || true
  fi
  rm -rf -- "$fixtures"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
server/target/debug/examples/generate_demo "$fixtures/demo.mcap" 2200
server/target/debug/examples/generate_visual "$fixtures/visual.mcap"
server/target/debug/hahn --data-dir "$fixtures" --listen "127.0.0.1:$port" >"$fixtures/server.log" 2>&1 &
server=$!
ready=false
for _ in {1..50}; do
  kill -0 "$server" 2>/dev/null || break
  if grep -q '^Hahn: http://' "$fixtures/server.log" \
    && curl -sf -o /dev/null "http://127.0.0.1:$port/api/runs"; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]] || ! kill -0 "$server" 2>/dev/null; then
  echo 'Conformance server did not start' >&2
  exit 1
fi
cd client
BASE_URL="http://127.0.0.1:$port" npm run --silent conformance
