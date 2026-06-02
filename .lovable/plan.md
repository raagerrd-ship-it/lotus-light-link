## Mål

Spela in den **oförvrängda musiksignalen** (FFT-band + flux @100 Hz) istället för den färdig-processade BLE-outputen @25 Hz. Rendera sedan ljuset offline från analysen med samma engine-mappning, polera och spela upp. Detta ger 4× upplösning och möjlighet till tyngre beat-/tempo-analys än Pi Zero 2W klarar i realtid — utan att duplicera DSP eller ladda upp rå-ljud.

Bakgrund (verifierat via kodanalys): ALSA 48 kHz → FFT 100 Hz → engine-tick ≤50 Hz → recorder 25 Hz. Vi flyttar inspelningen uppströms till 100 Hz-analystappen som redan är tillagd i `piEngine.ts`.

## Steg

### 1. `pi/src/piEngine.ts` — exportera band→ljus-mappning *(redan klart)*
Klart i tidigare turn: `normalizeFixed`, `computeTickConstants`, `applyDynamics` exporterade; `setAnalysisTap` + 100 Hz-tapp på `onFluxReady` med `[bass, midHi, total, flux]`. Live-beteende oförändrat.

### 2. `pi/src/seqRender.ts` (ny) — offline-renderare
`renderLightFromAnalysis(frames, settings)` som per analys-frame kör samma `band → pct + color` via de exporterade helpers. Använder egen offline-dynamik/onset-state (samma matte som live-ticken) så renderingen blir identisk med vad enginen hade gjort, fast deterministiskt och utan rate-limit/deadband.
→ verifiera: en kort syntetisk analys-buffer ger en monotont rimlig pct-kurva; `tsc` passerar.

### 3. `pi/src/lightRecorder.ts` — koppla 100 Hz-bufferten
- Ny analys-buffer `[tMs, bass, midHi, flux, total]` matad via `engine.setAnalysisTap` istället för 25 Hz `onFrame`-tappen för inspelning (frame-tappen behålls för auto-synk-korrelation).
- `MAX_FRAMES` → ~80 000 (≈13 min @100 Hz).
- `finalizeRecording()`: skriv `<key>.analysis.json`, kör `renderLightFromAnalysis` → `polish` → skriv `<key>.json`. **Behåll** `.analysis.json` (≈120 KB) för ångra/om-trimning — ersätter `.raw.json`.
- `revertSequence` blir "rendera om från analysen" istället för att tappa rå-ljus.
→ verifiera: en inspelning skapar både `.analysis.json` och `.json`; uppspelning fungerar.

### 4. `pi/src/seqPolish.ts` — ms-baserade konstanter för 100 Hz
Skala frame-beroende konstanter från 40 ms → 10 ms-grid: `SAMPLE_INTERVAL_MS`, `CALM_WINDOW`, `BEAT_WINDOW`, `BEAT_REFRACTORY`, `PREDIP_FRAMES`, `BEAT_TAIL` m.fl. uttrycks i ms och räknas om till frames utifrån faktiskt intervall, så beat-känslan blir identisk men finare.
→ verifiera: `analyze()` ger rimligt bpm/beats på 100 Hz-data.

### 5. Build + versionsbump
`cd pi && npx tsc -p tsconfig.json --noEmit` + bygg, bumpa `pi/package.json`-version.

## Tekniska detaljer
- `.analysis.json`-format: `{ key, durationMs, frames: [[tMs,bass,midHi,flux,total],...] }`. Float-band rundas till heltal (×1000-skala vid behov) för kompakthet.
- Bakåtkompatibilitet: gamla `.raw.json`/`.json` läses fortfarande; saknas `.analysis.json` faller `revert` tillbaka på befintlig `.json`.
- Frame-tappen (50 Hz) lämnas orörd för auto-synk-korskorrelationen.

## Avgränsning
Rått PCM-ljud (WAV, MB/låt, offline-FFT) byggs **inte** nu — band/flux @100 Hz är musikinnehållet före ljus-estetik och räcker. PCM kvarstår som tyngre framtidsalternativ.