#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "node binary not found" >&2
  exit 1
fi

exec "$NODE_BIN" "$DIR/server.mjs" "$@"
