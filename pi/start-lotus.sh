#!/bin/bash
# start-lotus.sh — Wrapper that starts both engine and frontend
# Used by Pi Dashboard's release-based install (single systemd service)
# Engine runs in background, frontend in foreground (systemd tracks this PID)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
BACKEND_PORT="${BACKEND_PORT:-3050}"

# Export for frontend
export BACKEND_PORT
export CONFIG_PORT="${PORT:-3001}"

# Start engine in background (dedicated to real-time audio + BLE)
"$NODE_BIN" --max-old-space-size=128 "$DIR/pi/dist/index.js" &
ENGINE_PID=$!
echo "[Wrapper] Engine started (PID $ENGINE_PID) on :$BACKEND_PORT"

# Cleanup: kill engine when frontend exits
cleanup() {
  echo "[Wrapper] Shutting down engine (PID $ENGINE_PID)..."
  kill "$ENGINE_PID" 2>/dev/null || true
  wait "$ENGINE_PID" 2>/dev/null || true
}
trap cleanup EXIT SIGINT SIGTERM

# Wait for engine API to be ready
for i in $(seq 1 15); do
  curl -sf "http://127.0.0.1:$BACKEND_PORT/api/status" > /dev/null 2>&1 && break
  sleep 1
done

# Start frontend in foreground (systemd tracks this PID)
exec "$NODE_BIN" --max-old-space-size=64 "$DIR/pi/dist/frontend.js"
