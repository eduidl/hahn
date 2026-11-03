#!/usr/bin/env bash
# Builds the client and drives it in a browser against synthetic recordings.
# Extra arguments go to Playwright, e.g. --update-snapshots or a test file.
set -euo pipefail
cd "$(dirname "$0")/.."
npm --prefix client run --silent build
cd client
exec ../scripts/synthetic-server.sh "${E2E_PORT:-3920}" npx playwright test "$@"
