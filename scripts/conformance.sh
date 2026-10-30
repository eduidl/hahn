#!/usr/bin/env bash
# Runs the conformance suite against the Rust server on a spare port.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${CONFORMANCE_PORT:-3918}"
cargo build --quiet
target/debug/hahn --data-dir data --listen "127.0.0.1:$port" >/dev/null &
server=$!
trap 'kill "$server"' EXIT
for _ in {1..50}; do
  curl -sf -o /dev/null "http://127.0.0.1:$port/api/runs" && break
  sleep 0.1
done
cd web
BASE_URL="http://127.0.0.1:$port" npm run --silent conformance
