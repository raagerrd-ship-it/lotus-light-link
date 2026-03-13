

# Börja om: Enkel ljusstyrning med fast basfärg

## Vad vi gör
Strippar bort all komplex ljud-till-ljus-logik i MicPanel (BPM-detektion, beat-phase, 4-zonsmodell, song sections, auto-calibrering, gain modes, punch white, etc.) och ersätter med en minimal loop:

1. **Fast basfärg**: Orange/Röd `[255, 80, 0]` — väljs av användaren
2. **Mikrofon → RMS → ljusstyrka** — enkel EMA-smoothad mapping
3. **Max 20 BLE-kommandon/sek** (50ms gap) — varje kommando skickar BÅDE färg + ljusstyrka
4. **Behåller**: BLE-anslutning, Sonos-integration, lokal proxy, bleStore, bledom.ts, auto-reconnect

## Tekniska ändringar

### 1. `src/components/MicPanel.tsx` — total omskrivning (~150 rader istället för 1055)
- Props: `char`, `currentColor`
- Mic → AudioContext → AnalyserNode (enkel, en analysator)
- Worker-tick var 50ms (20Hz):
  - Beräkna RMS från time-domain data
  - EMA-smoothing (attack 0.3, release 0.05)
  - Map till brightness 3-100%
  - Skicka `sendColor` + `sendBrightness` i sekvens (max 20/sek totalt = 10 color + 10 brightness, eller 20 interleaved)
- BLE-kö: enkel coalescing, 50ms min gap, skickar alltid BÅDE färg och ljusstyrka per tick
- Visuellt: behåll glow-cirkel + canvas chart (förenklad)

### 2. `src/pages/Index.tsx` — förenkling
- Ta bort: `sonosBpm`, `punchWhite`, `liveBpm`, `songSections`, `songDrops`, `autoDriftMs`, `currentSection`, `gainMode`, `volCalibration`, `dynamicDamping`, alla relaterade callbacks
- Behåll: BLE-anslutning, Sonos now-playing, palette-extraktion, NowPlayingBar
- Behåll: auto-reconnect, connect/disconnect
- Förenkla header: ta bort gain-mode, punch-white, vol-calibrate knappar
- Sätt default `currentColor` till `[255, 80, 0]` (orange/röd)
- MicPanel props: bara `char` och `currentColor`

### 3. Filer som behålls oförändrade
- `bledom.ts`, `bleStore.ts`, `useSonosNowPlaying.ts`, `colorExtract.ts`, `NowPlayingBar.tsx`
- `lightCalibration.ts` (behålls men används inte just nu)
- `AutoCalibratePanel.tsx`, `autoCalibrate.ts`, `Calibrate.tsx` (behålls men inaktiva)
- Edge functions, databas — oförändrat

### 4. Filer som kan tas bort (eller lämnas)
- `songSections.ts`, `bpmEstimate.ts` — används inte längre av MicPanel
- `DebugOverlay.tsx` — kan behållas men tas bort från Index

## BLE-kommandostruktur per tick (50ms)
```text
tick → sendColor(char, r, g, b) → sendBrightness(char, pct)
       ↑ alltid samma färg          ↑ baserat på mic RMS
       max 20 ticks/sek = 20 color + 20 brightness
       men BLE-kön coalescerar → max ~20 faktiska writes/sek
```

