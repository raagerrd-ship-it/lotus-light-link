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
│  Sonos SSE ← Sonos Gateway :3000        │
│  Config API → :3001                     │
└─────────────────────────────────────────┘
```

---

## 🚀 Installation Guide

### Prerequisites

- Raspberry Pi Zero 2 W
- INMP441 I²S MEMS microphone (soldered to GPIO)
- MicroSD card (16GB+) with RPi OS Lite 64-bit
- WiFi configured
- SSH enabled

### Step 1: Flash SD Card

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choose **Raspberry Pi OS Lite (64-bit)**
3. Click ⚙️ and configure:
   - Hostname: `lotus`
   - Enable SSH (password or key)
   - WiFi SSID + password
4. Flash and boot the Pi

### Step 2: Wire the INMP441 Microphone

```
INMP441        RPi Zero 2 W
─────────────────────────────
VDD    → 3.3V          (pin 1)
GND    → GND           (pin 6)
SCK    → GPIO 18 / PCM_CLK  (pin 12)
WS     → GPIO 19 / PCM_FS   (pin 35)
SD     → GPIO 20 / PCM_DIN  (pin 38)
L/R    → GND           (vänster kanal)
```

### Step 3: Install

SSH into the Pi and run:

```bash
# One-liner install (replace with your GitHub URL):
export REPO_URL="https://github.com/YOUR_USER/lotus-light-link.git"
curl -fsSL "https://raw.githubusercontent.com/YOUR_USER/lotus-light-link/main/pi/setup-lotus.sh" | sudo bash

# Or manual:
sudo apt-get install -y git
git clone https://github.com/YOUR_USER/lotus-light-link.git /opt/lotus-light
cd /opt/lotus-light
sudo bash pi/setup-lotus.sh
```

### Step 4: Reboot (first time only)

```bash
sudo reboot
```

The I²S audio overlay requires a reboot to activate.

### Step 5: Start & Verify

```bash
# Start the service
sudo systemctl start lotus-light

# Check status
sudo systemctl status lotus-light

# Watch logs
sudo journalctl -u lotus-light -f

# Test API
curl http://lotus.local:3001/api/status
```

You should see:
```
╔═══════════════════════════════════════════╗
║   Lotus Light Link — Pi Headless Runtime  ║
╚═══════════════════════════════════════════╝
  Tick: 30ms (33 Hz)
  Bridge: http://localhost:3000/api/sonos
[Boot] Starting ALSA microphone...
[Boot] Scanning for BLEDOM devices...
[Boot] ✓ All systems running
```

---

## 🔄 Auto-Update (GitHub)

The setup installs a systemd timer that checks GitHub every 5 minutes for updates.

### How It Works

```
lotus-update.timer (every 5 min)
       ↓
update-services.sh
       ↓
git fetch → compare HEAD
       ↓ (if changed)
git pull → npm install (if deps changed) → npm run build → restart service
```

### What Gets Watched

| Directory | Action on change |
|---|---|
| `pi/` | Rebuild + restart |
| `src/lib/engine/` | Rebuild + restart |
| Other files | Pull only, no restart |

### Manual Update

```bash
sudo bash /opt/lotus-light/pi/update-services.sh
```

### Check Update Logs

```bash
journalctl -u lotus-update -f
```

### Disable Auto-Update

```bash
sudo systemctl disable lotus-update.timer
sudo systemctl stop lotus-update.timer
```

---

## ⚙️ Configuration

### Environment Variables

Edit the systemd service to change defaults:

```bash
sudo systemctl edit lotus-light
```

Add overrides:
```ini
[Service]
Environment=BRIDGE_URL=http://localhost:3000/api/sonos
Environment=CONFIG_PORT=3001
Environment=TICK_MS=30
Environment=SSE_PATH=/events
Environment=STATUS_PATH=/status
Environment=POLL_INTERVAL_MS=2000
Environment=DISABLE_SSE=false
```

Then reload:
```bash
sudo systemctl daemon-reload
sudo systemctl restart lotus-light
```

### Sonos Gateway Config (runtime)

Point to your Sonos Gateway without restarting:

```bash
# Configure gateway URL
curl -X PUT http://lotus.local:3001/api/sonos-gateway \
  -H 'Content-Type: application/json' \
  -d '{
    "baseUrl": "http://localhost:3000/api/sonos",
    "ssePath": "/events",
    "statusPath": "/status",
    "pollIntervalMs": 2000
  }'

# Check current config
curl http://lotus.local:3001/api/sonos-gateway
```

This saves to `~/.lotus-light/sonos-gateway.json` and persists across restarts.

---

## 📡 Config API (port 3001)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | BLE + Sonos + engine status |
| `GET` | `/api/calibration` | Current calibration |
| `PUT` | `/api/calibration` | Merge calibration patch |
| `PUT` | `/api/color` | Set RGB color `{r,g,b}` |
| `GET` | `/api/idle-color` | Get idle color |
| `PUT` | `/api/idle-color` | Set idle color `{color:[r,g,b]}` |
| `PUT` | `/api/tick-ms` | Change tick rate `{tickMs:30}` |
| `GET` | `/api/sonos-gateway` | Get Sonos gateway config |
| `PUT` | `/api/sonos-gateway` | Set Sonos gateway config |

---

## 🔧 Troubleshooting

### No sound from mic
```bash
# Check ALSA devices
arecord -l
# Test recording (Ctrl+C to stop)
arecord -D plughw:0,0 -f S16_LE -r 44100 -c 1 /tmp/test.wav
aplay /tmp/test.wav
```

If no device found: check I²S overlay and reboot.

### BLE not finding devices
```bash
# Check Bluetooth
bluetoothctl show
# Scan manually
bluetoothctl scan on
# Check Node.js capability
getcap $(which node)
```

### Service won't start
```bash
# Full logs
journalctl -u lotus-light --no-pager -n 50
# Manual run for debugging
cd /opt/lotus-light/pi && sudo node dist/index.js
```

### Update not working
```bash
# Check timer
systemctl status lotus-update.timer
# Run manually with output
sudo bash /opt/lotus-light/pi/update-services.sh
# Check git remote
cd /opt/lotus-light && git remote -v
```

---

## Files

| File | Description |
|---|---|
| `src/index.ts` | Main entry — boots all subsystems |
| `src/alsaMic.ts` | ALSA mic → ring buffer → FFT bands |
| `src/nobleBle.ts` | noble BLE driver for BLEDOM protocol |
| `src/sonosPoller.ts` | Configurable SSE + poll for Sonos state |
| `src/piEngine.ts` | Headless LightEngine (AGC, smoothing, brightness) |
| `src/configServer.ts` | Express :3001 — REST API for config |
| `src/storage.ts` | File-based localStorage (~/.lotus-light/) |
| `setup-lotus.sh` | Full install script (deps, I²S, systemd) |
| `update-services.sh` | Auto-update script (GitHub → build → restart) |

## Performance Target

- **Tick interval**: 30ms (33 Hz) — 60% finer temporal resolution than browser baseline (40ms)
- **ALSA buffer**: ~1.5ms (vs Web Audio ~10-20ms)
- **BLE write**: ~25ms per GATT write (hardware limit)
- **Total pipeline**: <5ms (FFT + AGC + smoothing + BLE call)
