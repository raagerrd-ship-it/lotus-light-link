# Cross-cutting notes (my own, to fold into synthesis)

## UI polling → WiFi/BLE shared-radio contention (Zero 2 W)
Mobile UI (src/) runs MANY concurrent poll intervals against the Pi over WiFi:
- `setInterval(tick, 200)` = 5 Hz (live strip / beat monitor)
- `setInterval(poll, 1000)` = 1 Hz
- several at 2000 / 5000 / 10000 ms + a mic poll
On the Zero 2 W, WiFi and BLE share ONE radio → this HTTP polling traffic contends with BLE writes to the
lamp → contributes to the 'ble-delivery' stalls/jitter. When the phone UI is open the contention is worst.
IDEA: collapse the many polls into ONE Server-Sent-Events / websocket stream from the engine (push, not
poll); pause/slow polling when the tab is hidden or the beat monitor isn't visible; cap live cadence.
Severity: MED-HIGH robustness/perf (directly feeds the known freeze mechanism).

## Node heap cap drift
- Repo: pi/services.json + setup-lotus.sh systemd ExecStart → `--max-old-space-size=96 --max-semi-space-size=4`
- setup-lotus.sh:154 (build step) → `--max-old-space-size=256`
- Live engine (per ops): running at `--max-old-space-size=144`
Three different numbers. Deployed value (144) ≠ repo (96). Pick one intentional value for 512MB and make
repo == deployed so a reinstall doesn't silently change GC behavior (heap size affects GC pause length =
freeze risk). Severity: LOW-MED robustness/reproducibility.

## Frontend deps not on Pi (context)
Root package.json deps (React/Vite/Supabase/radix) are the WEB UI, built to static — NOT running on the Pi.
The Pi runs pi/ (own package.json + vendor/alsa-capture native binding). So frontend dep weight is not a Pi
CPU/RAM concern; only the served bundle size + the polling cadence above matter to the device.

## Files/scale (for the report)
pi/src ≈ 11k lines TS. Biggest: configServer.ts 1665, piEngine.ts 1634, analyser.ts 1443, alsaMic.ts 984,
index.ts 668, ble-driver/connect.ts 645, ble-driver/protocol.ts 518. Plus 86 design notes in .lovable/memory/.
BLE subsystem is spread across ~15 files (ble-driver/ + ble/) — a simplification target to assess.
