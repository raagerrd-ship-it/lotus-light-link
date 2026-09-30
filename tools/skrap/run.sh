#!/usr/bin/env bash
# Skrapbanken: kor HELA lotus-motorn (dist/index.js) i realtid pa PC med falsk mic/BLE/gateway och Pi:ns env + heap-flaggor.
#   run.sh <namn> <pi-katalog med dist> [extra node-flaggor...]
#   env: RUN_S (300), PROF_WARM_S (120), PROF_SECS (0 = ingen profil), POLL_MS (0 = ingen UI-poll av /api/live)
#        PIDATA = katalog med kopia av Pi:ns DATA_DIR-json (lases via sftp, skrivs aldrig), RUNS = utkatalog, PLAYLIST = spellista
#   Windows: register.mjs satter 1 ms timerupplosning via koffi (npm i koffi i en katalog ovanfor) - utan den tickar motorn
#   i 15,6 ms-steg. Profil: node profTop.mjs <RUNS>/<namn>/alloc.heapprofile <PROF_SECS>; GC: gcParse.mjs (dmx tools/mem).
#   Deterministisk motsvarighet (virtuell klocka, bevis for oforandrat ljus): engineReplay.mjs.
set -u
H=$(cd "$(dirname "$0")" && pwd)
S=$(dirname "$H")
NAME=$1; PIDIR=$2; shift 2
OUT=${RUNS:-$S/runs}/$NAME; rm -rf "$OUT"; mkdir -p "$OUT/data/home"
WOUT=$(cygpath -m "$OUT"); WH=$(cygpath -m "$H")
cp "${PIDATA:-$S/pidata-orig}"/*.json "$OUT/data/"
T0=$(node -e 'console.log(Date.now()+3000)')
GW_PORT=${GW_PORT:-3953}; ENG_PORT=${ENG_PORT:-3951}
HARNESS_PLAYLIST="${PLAYLIST:-$WH/playlist.json}" HARNESS_T0=$T0 GW_PORT=$GW_PORT node "$WH/fakeGateway.mjs" > "$OUT/gw.log" 2>&1 &
GWPID=$!
if [ "${POLL_MS:-0}" != "0" ]; then
  ( sleep 20; while kill -0 $GWPID 2>/dev/null; do curl -s -m 2 "http://127.0.0.1:$ENG_PORT${POLL_PATH:-/api/live}" > /dev/null; sleep $(node -e "console.log(${POLL_MS}/1000)"); done ) &
  POLLPID=$!
fi
cd "$PIDIR"
env -i PATH="$PATH" SYSTEMROOT="${SYSTEMROOT:-C:\\Windows}" TEMP="${TEMP:-}" TMP="${TMP:-}" \
  HARNESS_PLAYLIST="${PLAYLIST:-$WH/playlist.json}" HARNESS_T0=$T0 \
  RUN_S=${RUN_S:-300} PROF_WARM_S=${PROF_WARM_S:-120} PROF_SECS=${PROF_SECS:-0} PROF_OUT="$WOUT/alloc" PROF_INTERVAL=${PROF_INTERVAL:-1024} \
  PCC_APP_KEY=lotus-light PCC_CONFIG_DIR="$WOUT/data" PCC_DATA_DIR="$WOUT/data" PCC_LOG_DIR="$WOUT" PORT=$ENG_PORT ENGINE_PORT=$ENG_PORT UI_PORT=3001 \
  HOME="$WOUT/data/home" NODE_ENV=production \
  LOTUS_ANALYSER_SPLIT=${SPLIT:-worker} LOTUS_SECTION_REPEAT=117 LOTUS_SECTION_W_HIGH=1.0 LOTUS_BAND_EVERY_HOPS=3 LOTUS_BLE_INTERVAL_UNITS=14 \
  BRIDGE_URL=http://127.0.0.1:$GW_PORT/api LOTUS_DROP_CALM_GATE=1 DROP_CALM_INTRO_STRICT=1 DROP_QUALITY_DB=6.5 BODY_RISE_DB=17 DROP_ARM_MS=300 \
  DROP_RISE_MIN=1 BODY_FAST_S=0.06 DROP_RISE_LOW_DB=12 LOTUS_GRID_PHASE_OFFSET_MS=15 LOTUS_PLL_RING=0 LOTUS_SECTION_CAPTURE_S=0 \
  LOTUS_SECTION_CAPTURE_MAX=200 LOTUS_SECTION_EARLY_S=45 LOTUS_SECTION_ON_HINT=1 LOTUS_TEMPO_UP43=1 LOTUS_TEMPO_EVIDENCE=1 LOTUS_TEMPO_ENV_S=10 \
  LOTUS_KICK_NOGATE=1 LOTUS_KICK_COOLDOWN=100 LOTUS_GRID_PHASE=1 LOTUS_PHASE_FOLLOW=1 LOTUS_SECTION=1 LOTUS_TICK_SYNC=1 LOTUS_TICK_SYNC_GUARD_MS=4 \
  BLE_ACL_MAX_OUTSTANDING=2 LOTUS_PULSE_PREDICT=1 ${EXTRA_ENV:-} \
  node --max-old-space-size=144 --min-semi-space-size=4 --max-semi-space-size=4 "$@" --import "file:///$WH/register.mjs" dist/index.js > "$OUT/engine.log" 2>&1
kill $GWPID 2>/dev/null; [ -n "${POLLPID:-}" ] && kill $POLLPID 2>/dev/null
echo "klart: $OUT"
