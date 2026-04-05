
# Raspberry Pi Zero 2 W — Komplett Setup-plan

## Pi #1: Lotus Light Link + Cast Away Web

### Hårdvara
- Raspberry Pi Zero 2 W (quad-core, WiFi, BLE)
- INMP441 I²S MEMS-mikrofon
- 12.5W USB-C PSU
- GPIO pin-headers (att löda)
- MicroSD-kort

### GPIO-koppling: INMP441 → Pi #1
```
INMP441        RPi Zero 2 W
VDD    → 3.3V  (pin 1)
GND    → GND   (pin 6)
SCK    → GPIO 18 / PCM_CLK  (pin 12)
WS     → GPIO 19 / PCM_FS   (pin 35)
SD     → GPIO 20 / PCM_DIN  (pin 38)
L/R    → GND (vänster kanal)
```

### Tjänster på Pi #1

#### 1. Cast Away Web — port 3000
- Projekt: `db36ca02-4c2b-4e0e-a58f-a351aa767ebf`
- Redan har `bridge/install-linux.sh` som skapar systemd-tjänst
- Klonas från GitHub, körs som-is
- Innehåller två OBEROENDE moduler:
  - **Sonos-proxy** — hämtar now-playing metadata (låt, artist, album art, position, nästa spår) från Sonos-högtalarna via UPnP. Exponerar REST/SSE-endpoints. Ljusmotorn konsumerar denna data.
  - **Chromecast-kontroll** — övervakar Chromecast, upptäcker IDLE-status, castar en förvald webbsida via registrerad Google Cast-app. Helt oberoende av Sonos.

#### 2. Lotus Light Link (headless ljusmotor) — port 3001
- Projekt: `cd9f7cfd-edf1-4738-9075-359f65e22ecd`
- Kräver headless port i `pi/`-mapp:
  - `pi/alsaMic.ts` — ALSA-wrapper ersätter Web Audio API
  - `pi/nobleBle.ts` — noble-wrapper ersätter Web Bluetooth
  - `pi/sonosPoller.ts` — pollar Cast Away bridge för now-playing
  - `pi/index.ts` — huvudprocess
  - `pi/configServer.ts` — Express på :3001 för mobilkonfigurering
- Kärn-engine-filer (`agc.ts`, `brightnessEngine.ts`, `audioAnalysis.ts`, `lightCalibration.ts`) importeras direkt, ingen duplicering
- Kräver: `noble`, `node-record-lpcm16`, `fft-js`

---

## Pi #2: Brew Monitor TV

### Hårdvara
- Raspberry Pi Zero 2 W (quad-core, WiFi, BLE)
- 7" HDMI pekskärm (1024×600, USB touch)
- HW-281 8-kanals relämodul (5V, optoisolerad, active low)
- 4× MAX31865 RTD-breakout (SPI)
- 4× PT100-prob (4-tråd) i rostfria dykrör
  - 1× glykol-kylare
  - 3× jästankar (botten — toppen mäts av RAPT Pill)
- 12.5W USB-C PSU
- MicroSD-kort

### GPIO-koppling: Pi #2

#### SPI-buss (delad) → 4× MAX31865
```
MAX31865       RPi Zero 2 W
MOSI    → GPIO 10 / SPI_MOSI  (pin 19)   [delad]
MISO    → GPIO 9  / SPI_MISO  (pin 21)   [delad]
SCLK    → GPIO 11 / SPI_SCLK  (pin 23)   [delad]

CS per enhet:
#1 Glykol   → GPIO 8  / CE0     (pin 24)
#2 Tank 1   → GPIO 7  / CE1     (pin 26)
#3 Tank 2   → GPIO 25           (pin 22)
#4 Tank 3   → GPIO 24           (pin 18)
```

#### HW-281 reläer (8 kanaler)
```
Relä    GPIO    Pin     Funktion
IN1  → GPIO 5   (pin 29)   Tank 1 kyla
IN2  → GPIO 6   (pin 31)   Tank 1 värme
IN3  → GPIO 13  (pin 33)   Tank 2 kyla
IN4  → GPIO 19  (pin 35)   Tank 2 värme
IN5  → GPIO 26  (pin 37)   Tank 3 kyla
IN6  → GPIO 12  (pin 32)   Tank 3 värme
IN7  → GPIO 16  (pin 36)   Glykolpump
IN8  → GPIO 20  (pin 38)   Reserv

VCC  → 5V (pin 2 eller extern PSU)
GND  → GND (pin 14)
```

**GPIO-budget: 15 av 26 använda — 11 lediga**

### Temperaturmätning per tank
| Plats | Sensor | Gränssnitt | Noggrannhet |
|---|---|---|---|
| Topp | RAPT Pill | BLE passiv scan | ±0.5°C + gravity |
| Botten | PT100 4-tråd i dykrör | SPI via MAX31865 | ±0.05–0.1°C |
| Snitt | `(pill_temp + pt100_temp) / 2` | Beräknat | — |
| Glykol | PT100 4-tråd i dykrör | SPI via MAX31865 | ±0.05–0.1°C |

### Tjänster på Pi #2

#### 1. brew-monitor-tv — port 3000
- Projekt: `fc7fbdf7-4480-491f-816e-37d0f6c3b251`
- Chromium kiosk-läge → 7" pekskärm (1024×600)
- Visar jässtatus, grafer, temperatur, gravity i realtid
- Befintlig kylstyrningslogik migreras från RAPT API till lokal GPIO

#### 2. RAPT Pill BLE Scanner
- Passiv BLE-scanning av RAPT Pill advertisements
- Parser temperatur + gravity direkt från beacon-paket
- Pushar data till brew-monitor-tv:s databas
- ~1s latens istället för minuter via RAPT API

#### 3. Temperatur & reläkontroll-tjänst — port 3001
- Läser 4× MAX31865 via SPI (`spi-device` npm-paket)
- Styr HW-281 reläer via GPIO (`onoff` npm-paket)
- PID/hysteres-logik för kyl/värme per tank
- Exponerar REST-API för brew-monitor-tv
- Loggar temperaturer + relästatus till databasen

---

## Gemensamt

### OS & grundinstallation (båda Pi:ar)
1. RPi OS Lite 64-bit via Raspberry Pi Imager
2. Förhandskonfigurera: WiFi, SSH
   - Pi #1: hostname=`lotus.local`
   - Pi #2: hostname=`brew.local`
3. Installera: Node.js 20, bluez, libbluetooth-dev
4. Pi #1 extra: `dtoverlay=googlevoicehat-soundcard`, libasound2-dev
5. Pi #2 extra: SPI aktiverat (`dtparam=spi=on`)

### Auto-uppdatering
- Alla projekt kopplas till GitHub via Lovable
- Cron-job var 5:e minut kör `update-services.sh`
- Scriptet gör `git fetch` → jämför HEAD → `git pull` + `npm install` + restart vid ändringar

### BLE-samexistens
- noble kan hantera passiv scanning (RAPT Pill) och aktiva GATT-connections (BLEDOM) samtidigt
- En BLE-radio per Pi räcker — scanning och connections körs parallellt i HCI-lagret

## Arkitektur
```
┌──────────────────────────────────────────────┐
│           Pi #1: lotus.local                 │
│                                              │
│  ┌──────────────────┐  ┌────────────────┐    │
│  │ Cast Away Web    │  │ Lotus Light    │    │
│  │ :3000            │  │ Engine         │    │
│  │                  │  │ :3001 (config) │    │
│  │ Sonos-proxy ─────│─▶│ (now-playing)  │    │
│  │ CC idle-cast     │  └───────┬────────┘    │
│  └──┬──────────┬────┘         │              │
│     │          │          BLE GATT            │
│  Sonos      Chromecast    → LED-strips       │
│  (UPnP)    (idle→cast)                       │
│  oberoende  oberoende     INMP441 mic (I²S)  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│           Pi #2: brew.local                  │
│                                              │
│  ┌──────────────────┐  ┌────────────────┐    │
│  │ brew-monitor-tv  │  │ Temp & Relä    │    │
│  │ :3000 (kiosk)    │  │ Controller     │    │
│  │ 7" pekskärm      │  │ :3001          │    │
│  └──────────────────┘  └──┬─────────┬───┘    │
│                           │         │        │
│  RAPT Pill BLE scan    4×MAX31865  HW-281    │
│  → temp + gravity      (SPI)      (GPIO)    │
│  → Supabase DB         PT100      8 reläer   │
│                        4-tråd     kyl/värme   │
│                        i dykrör              │
└──────────────────────────────────────────────┘
```

## Att bygga

### Pi #1 (när hårdvaran anländer)
1. `pi/` headless runtime i Lotus Light Link
2. `setup-lotus.sh` — install-script
3. systemd-tjänster

### Pi #2
1. Lokal tjänst: SPI-läsning (MAX31865) + GPIO-styrning (HW-281)
2. Migrera kylstyrningslogik från RAPT API → lokal GPIO
3. BLE-scanner för RAPT Pill
4. Chromium kiosk-läge för 7" skärm
5. `setup-brew.sh` — install-script
6. systemd-tjänster

### Gemensamt
1. `update-services.sh` — auto-update script
2. 3D-printbara höljen (OpenSCAD → STL)
