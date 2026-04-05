

## Uppdatera planen med korrekta Sonos/Chromecast-beskrivningar

Planen i `.lovable/plan.md` har felaktiga beskrivningar som antyder att Sonos och Chromecast är sammankopplade. De ska uppdateras så det framgår att de är **helt oberoende moduler**.

### Ändringar

**1. Rubrik för Cast Away Web (rad 25)**
Ändra från "Sonos/Chromecast bridge" till tydligare beskrivning med två separata punkter:

```
### 1. Cast Away Web — port 3000
- Projekt: db36ca02-4c2b-4e0e-a58f-a351aa767ebf
- Redan har bridge/install-linux.sh som skapar systemd-tjänst
- Klonas från GitHub, körs som-is
- Innehåller två OBEROENDE moduler:
  - **Sonos-proxy** — hämtar now-playing metadata (låt, artist, album art, position, nästa spår) från Sonos-högtalarna via UPnP. Exponerar REST/SSE-endpoints. Ljusmotorn konsumerar denna data.
  - **Chromecast-kontroll** — övervakar Chromecast, upptäcker IDLE-status, castar en förvald webbsida via registrerad Google Cast-app. Helt oberoende av Sonos.
```

**2. Arkitekturdiagrammet (rad 60-84)**
Uppdatera så Sonos och Chromecast visas som separata, oberoende pilar:

```text
┌──────────────────────────────────────────────┐
│           Raspberry Pi Zero 2 W              │
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
│                                              │
│  ┌─────────────┐                             │
│  │ RAPT Pill   │                             │
│  │ Scanner     │                             │
│  │ :3002       │                             │
│  └──────┬──────┘                             │
│    BLE passive scan                          │
│    → Supabase DB                             │
│                                              │
│  Auto-update via cron + git pull             │
└──────────────────────────────────────────────┘
```

### Verktyg
Använder `plan--create` för att skriva den uppdaterade planen.

