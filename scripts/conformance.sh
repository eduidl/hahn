#!/usr/bin/env bash
# Runs the current contract against synthetic recordings on a spare port.
set -euo pipefail
cd "$(dirname "$0")/.."
exec scripts/synthetic-server.sh "${CONFORMANCE_PORT:-3918}" npm --prefix client run --silent conformance
