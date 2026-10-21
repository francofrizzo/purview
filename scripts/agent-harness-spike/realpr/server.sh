#!/bin/sh
# server.sh <state-root-of-arm> <port> — a private Purview over one arm's state copy. Never 4779.
# Expects PURVIEW_CLAUDE_BIN, PURVIEW_CODEX_BIN and PURVIEW_CODEX_HOME in the environment (see integration.md).
ROOT=$1; PORT=$2; HERE=$(cd "$(dirname "$0")/../../.." && pwd)
[ "$PORT" = "4779" ] && { echo "refusing port 4779 (the reader's own Purview)"; exit 1; }
exec env PURVIEW_STATE_DIR="$ROOT" PURVIEW_PORT="$PORT" PURVIEW_EXPERIMENTAL_HARNESSES=1 node "$HERE/packages/server/dist/index.js"
