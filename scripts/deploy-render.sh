#!/usr/bin/env bash
set -euo pipefail

echo "[deploy] Running build..."
npm run build

echo "[deploy] Build complete. Public assets ready."

if [[ -n "${RENDER:-}" ]]; then
  echo "[deploy] Restarting server for Render..."
  pkill -f "node server.js" || true
fi

echo "[deploy] Starting server..."
node server.js
