

## TV-läge med auto-detect toggle

### Koncept
En toggle-inställning **"Auto TV-läge"** som användaren kan slå på/av. När aktiverad detekterar systemet automatiskt TV/SPDIF-källa (Sonos PLAYING + inget trackName) och växlar till mikrofon-reaktiv belysning. När avaktiverad behålls nuvarande beteende (idle-färg vid saknad metadata).

### Flödesschema
```text
Auto TV-läge: PÅ
  Sonos PLAYING + trackName  →  Normal-profil (musik + palett)
  Sonos PLAYING + !trackName →  TV-läge (mikrofon-reaktiv, idle-färg)
  Sonos PAUSED / idle        →  Idle (fast idle-färg)

Auto TV-läge: AV
  Sonos PLAYING + !trackName →  Idle (nuvarande beteende, PAUSED)
```

### Ändringar

**1. `src/lib/engine/lightCalibration.ts`** — Ny setting
- Lägg till `autoTvMode: boolean` i `LightCalibration` (default: `false`)
- Separat localStorage-nyckel eller del av calibration-objektet

**2. `pi/src/sonosPoller.ts`** — `isTvMode` i SonosState
- Nytt fält `isTvMode: boolean` (default `false`)
- I `parseStatus`: om `!trackName` och playbackState innehåller PLAYING → `isTvMode = true`, behåll PLAYING istället för att tvinga PAUSED
- Ny funktion `setAutoTvMode(enabled: boolean)` som styr om TV-detection är aktiv

**3. `src/hooks/useSonosNowPlaying.ts`** — Samma detection i browser
- Lägg till `isTvMode: boolean` i `SonosNowPlaying`
- Läs `autoTvMode` från calibration; om aktiv och `!trackName` + PLAYING → `isTvMode = true`

**4. `src/components/NowPlayingBar.tsx`** — TV-indikator
- Om `isTvMode` → visa "📺 TV-läge" istället för låtinfo, dölj progress bar

**5. `src/pages/Calibrate.tsx`** — Toggle i UI
- Ny switch/toggle: "Auto TV-läge" med beskrivning "Aktivera mikrofon-reaktiv belysning vid TV/SPDIF-källa"

**6. `pi/src/index.ts`** — Engine-hantering
- Vid `isTvMode` → `engine.setPlaying(true)`, hoppa över palette-extraktion
- Vid övergång tillbaka → återställ Normal-profil automatiskt

**7. `pi/src/configServer.ts`** — API-endpoint
- GET/PUT `/api/auto-tv-mode` för att synka toggle till Pi

### Filer som ändras (7 st)
`lightCalibration.ts`, `sonosPoller.ts`, `useSonosNowPlaying.ts`, `NowPlayingBar.tsx`, `Calibrate.tsx`, `pi/src/index.ts`, `pi/src/configServer.ts`

