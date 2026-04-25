---
name: Tyst engine per default — console.log endast bakom LOTUS_DEBUG=1
description: All loggning i hot/lifecycle paths går via dlog() från pi/src/debugLog.ts. Default tyst (warn/error når journald). Aktivera verbose: Environment=LOTUS_DEBUG=1 i systemd-uniten + restart. UI:t exponerar live-state via /api/status.live (Input/Output/Kö/Färg/Låt) — inte via loggen.
type: constraint
---
**Inga `console.log` i pi/src/ utanför `pi/src/debugLog.ts`.** Använd `dlog(...)` istället. `console.warn` och `console.error` är OK (riktiga fel måste alltid synas i journald) men ska användas sparsamt och med rate-limit på rep-skadliga loopar.

**Aktivera verbose loggning vid felsökning:**
```bash
sudo systemctl edit lotus-light-engine
# [Service]
# Environment=LOTUS_DEBUG=1
sudo systemctl restart lotus-light-engine
```

**UI-strip (`src/components/LiveStrip.tsx`)** pollar `/api/status` @ 4 Hz och visar realtidsmetrics som ersätter behovet av tail-logging:
- Input level (mic totalRms 0..1)
- Output level (brightness 0..1)
- BLE outstanding queue
- Aktuell utskickad färg (rgb-swatch)
- Nuvarande Sonos-låt + artist

`/api/status` payload har nytt fält `live: { inputLevel, outputBrightness, color, track, artist, queue }`. Lägg aldrig till nya logg-rader på FFT-tick, BLE-write eller ALSA-callback — exponera istället som `live`-fält.

Verifierat 2026-04-25.
