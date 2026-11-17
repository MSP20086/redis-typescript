#!/bin/sh
# Start the server. All arguments are forwarded, e.g.:
#   ./scripts/run.sh --port 6380 --appendonly yes
set -e
exec bun run "$(dirname "$0")/../app/main.ts" "$@"
