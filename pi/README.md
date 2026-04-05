# Lotus Light Link — Pi Headless Runtime

Headless audio-reactive LED controller for Raspberry Pi Zero 2 W.
Same engine as the web app, but using ALSA microphone + noble BLE instead of Web Audio/Web Bluetooth.

## Architecture

```
┌─────────────────────────────────────────┐
│  Pi #1: lotus.local                     │
│                                         │
│  INMP441 mic → ALSA → FFT → AGC        │
│       ↓                                 │
│  PiLightEngine (30ms tick / 33 Hz)      │
│       ↓                                 │
│  noble → BLE GATT → BLEDOM LED strips   │
│                                         │
│  Sonos SSE ← Cast Away :3000            │
│  Config API → :3001                     │
└─────────────────────────────────────────┘
```

## Files

| File | Description |
|---|---|
| `src/index.ts` | Main entry — boots all subsystems |
| `src/alsaMic.ts` | ALSA mic → ring buffer → FFT bands |
| `src/nobleBle.ts` | noble BLE driver for BLEDOM protocol |
| `src/sonosPoller.ts` | SSE + fallback poll for Sonos state |
| `src/piEngine.ts` | Headless LightEngine (AGC, smoothing, brightness) |
| `src/configServer.ts` | Express :3001 — calibration, color, status API |
| `src/storage.ts` | File-based localStorage replacement (~/.lotus-light/) |
| `setup-lotus.sh` | System install script (deps, systemd, I²S) |

## Quick Start

```bash
# On Pi:
cd /opt/lotus-light
sudo bash pi/setup-lotus.sh

# Or manual:
cd pi
npm install
npm run build
node dist/index.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_URL` | `http://localhost:3000/api/sonos` | Cast Away proxy URL |
| `CONFIG_PORT` | `3001` | Config API port |
| `TICK_MS` | `30` | Engine tick interval (ms) |

## Config API (port 3001)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | BLE + Sonos + engine status |
| `GET` | `/api/calibration` | Current calibration |
| `PUT` | `/api/calibration` | Merge calibration patch |
| `PUT` | `/api/color` | Set RGB color `{r,g,b}` |
| `GET` | `/api/idle-color` | Get idle color |
| `PUT` | `/api/idle-color` | Set idle color `{color:[r,g,b]}` |
| `PUT` | `/api/tick-ms` | Change tick rate `{tickMs:30}` |

## Hardware Wiring

```
INMP441        RPi Zero 2 W
VDD    → 3.3V  (pin 1)
GND    → GND   (pin 6)
SCK    → GPIO 18 / PCM_CLK  (pin 12)
WS     → GPIO 19 / PCM_FS   (pin 35)
SD     → GPIO 20 / PCM_DIN  (pin 38)
L/R    → GND (vänster kanal)
```

## Performance Target

- **Tick interval**: 30ms (33 Hz) — 60% finer temporal resolution than browser baseline (40ms)
- **ALSA buffer**: ~1.5ms (vs Web Audio ~10-20ms)
- **BLE write**: ~25ms per GATT write (hardware limit)
- **Total pipeline**: <5ms (FFT + AGC + smoothing + BLE call)
