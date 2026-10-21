#!/bin/sh
# server.sh <state-root-of-arm> <port> — a private Purview over one arm's state copy. Never 4779.
# Expects PURVIEW_CLAUDE_BIN, PURVIEW_CODEX_BIN and PURVIEW_CODEX_HOME in the environment (see integration.md).
set -eu
ROOT=${1-}; PORT=${2-}; HERE=$(cd "$(dirname "$0")/../../.." && pwd)
node --input-type=module - "$ROOT" "$PORT" "$HERE" <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [root, port, here] = process.argv.slice(2);
const { canonical, overlaps, checkPort } = await import(path.join(here, 'scripts/agent-harness-spike/realpr/protocol.mjs'));
try {
checkPort(port);
if (!root || !fs.statSync(root).isDirectory() || overlaps(canonical(root), canonical(path.join(os.homedir(), '.purview')))) throw Error('unsafe state root');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
if (config.managedCheckouts !== false || config.autoAnalyze !== false || config.lan) throw Error('not a private comparison root');
} catch { console.error('unsafe server arguments or state root'); process.exit(1); }
JS
exec env PURVIEW_STATE_DIR="$ROOT" PURVIEW_PORT="$PORT" PURVIEW_EXPERIMENTAL_HARNESSES=1 node "$HERE/packages/server/dist/index.js"
