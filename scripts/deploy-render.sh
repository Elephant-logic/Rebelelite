#!/usr/bin/env bash
set -euo pipefail

echo "[deploy] Running build..."
npm run build

echo "[deploy] Build complete. Public assets ready."

if [[ -n "${RENDER_DEPLOY_HOOK:-}" ]]; then
  echo "[deploy] Triggering Render deploy hook..."
  curl -fsS -X POST "$RENDER_DEPLOY_HOOK" >/dev/null
  echo "[deploy] Render deploy triggered."
  exit 0
fi

echo "[deploy] No Render deploy hook configured."
echo "[deploy] Set RENDER_DEPLOY_HOOK to your Render deploy hook URL to publish this build."
