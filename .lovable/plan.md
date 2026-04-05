
# Raspberry Pi Zero 2 W — Komplett Setup-plan

## Hårdvara (beställt från Electrokit)
- Raspberry Pi Zero 2 W (quad-core, WiFi, BLE)
- INMP441 I²S MEMS-mikrofon
- 12.5W USB-C PSU
- GPIO pin-headers (att löda)
- MicroSD-kort (redan har)
- 3D-skrivare + lödstation (redan har)

## GPIO-koppling: INMP441 → Pi Zero 2 W
```
INMP441        RPi Zero 2 W
VDD    → 3.3V  (pin 1)
GND    → GND   (pin 6)
SCK    → GPIO 18 / PCM_CLK  (pin 12)
WS     → GPIO 19 / PCM_FS   (pin 35)
SD     → GPIO 20 / PCM_DIN  (pin 38)
L/R    → GND (vänster kanal)
```

## Tre tjänster på Pi:n

### 1. Cast Away Web (Sonos/Chromecast bridge) — port 3000
- Projekt: `db36ca02-4c2b-4e0e-a58f-a351aa767ebf`
- Redan har `bridge/install-linux.sh` som skapar systemd-tjänst
- Klonas från GitHub, körs som-is

### 2. Lotus Light Link (headless ljusmotor) — port 3001
- Projekt: `cd9f7cfd-edf1-4738-9075-359f65e22ecd`
- Kräver headless port i `pi/`-mapp:
  - `pi/alsaMic.ts` — ALSA-wrapper ersätter Web Audio API
  - `pi/nobleBle.ts` — noble-wrapper ersätter Web Bluetooth
  - `pi/sonosPoller.ts` — pollar Cast Away bridge för now-playing
  - `pi/index.ts` — huvudprocess
  - `pi/configServer.ts` — Express på :3001 för mobilkonfigurering
- Kärn-engine-filer (`agc.ts`, `brightnessEngine.ts`, `audioAnalysis.ts`, `lightCalibration.ts`) importeras direkt, ingen duplicering
- Kräver: `noble`, `node-record-lpcm16`, `fft-js`

### 3. RAPT Pill BLE Scanner — port 3002
- Projekt: `fc7fbdf7-4480-491f-816e-37d0f6c3b251` (brew-monitor-tv)
- Passiv BLE-scanning av RAPT Pill advertisements via noble
- Parser temperatur + gravity direkt från beacon-paket
- Pushar data till brew-monitor-tv:s databas (Supabase)
- Ersätter molnbaserad RAPT API-polling → ~1s latency istället för minuter

## OS & grundinstallation
1. RPi OS Lite 64-bit via Raspberry Pi Imager
2. Förhandskonfigurera: WiFi, SSH, hostname=`lotus.local`
3. Aktivera I²S: `dtoverlay=googlevoicehat-soundcard` i `/boot/firmware/config.txt`
4. Installera: Node.js 20, bluez, libbluetooth-dev, libasound2-dev
5. Verifiera mic: `arecord -l`

## Auto-uppdatering
- Alla tre projekt kopplas till GitHub via Lovable
- Cron-job var 5:e minut kör `update-services.sh`
- Scriptet gör `git fetch` → jämför HEAD → `git pull` + `npm install` + restart vid ändringar

## Arkitektur
```
┌─────────────────────────────────────────┐
│         Raspberry Pi Zero 2 W           │
│                                         │
│  ┌─────────────┐  ┌────────────────┐    │
│  │ Cast Away   │  │ Lotus Light    │    │
│  │ Bridge      │  │ Engine         │    │
│  │ :3000       │─▶│ :3001 (config) │    │
│  └─────────────┘  └───────┬────────┘    │
│        │                  │             │
│   Sonos/CC           BLE GATT           │
│   via WiFi           → LED-strips       │
│                                         │
│  ┌─────────────┐                        │
│  │ RAPT Pill   │  INMP441 mic (I²S)     │
│  │ Scanner     │                        │
│  │ :3002       │                        │
│  └──────┬──────┘                        │
│    BLE passive scan                     │
│    → Supabase DB                        │
│                                         │
│  Auto-update via cron + git pull        │
└─────────────────────────────────────────┘
```

## Att bygga när hårdvaran anländer
1. `pi/` headless runtime i Lotus Light Link (ALSA mic, noble BLE, Express config)
2. `rapt-scanner/` tjänst (noble passive scan, beacon parser, Supabase push)
3. `setup.sh` — komplett install-script för allt
4. `update-services.sh` — auto-update script
5. 3D-printbart hölje (OpenSCAD → STL)
6. systemd-tjänster för alla tre services

## BLE-samexistens
- noble kan hantera passiv scanning (RAPT) och aktiva GATT-connections (BLEDOM) samtidigt
- En BLE-radio räcker — scanning och connections körs parallellt i HCI-lagret
