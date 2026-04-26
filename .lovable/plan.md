## Mål

Ta bort slew-rate limitern (block 6b i `piEngine.tickInner`) eftersom anti-alias-bufferten i `alsaMic` redan tar bort frame-to-frame-bruset som slew-en var till för. Behåll deadband (block 7b) och adaptiv onset-suppression — de har inget med latens att göra och fyller fortfarande ett musikaliskt syfte.

## Vad försvinner

**Block 6b i `pi/src/piEngine.ts` (rad 932–944):**
- Slew-räknaren på `energyNorm` med `maxRisePerSec` / `maxFallPerSec`
- Skrivningen till `this.lastBrightness` försvinner med blocket

**Effekt:** Snabba kicks/transienter går rakt igenom utan att begränsas av rise-taket. Smoothness säkras nu av:
1. Anti-alias rolling average i `alsaMic` (~30 ms)
2. EMA i `tickInner` (releaseAlpha)
3. Dynamics + adaptiv onset-suppression
4. Deadband (oförändrad)

## Vad behålls

- **Deadband (rad 967–978)** — fryser BLE-skick på platta partier, ingen latens-kostnad
- **Adaptiv onset-suppression i `processOnset`** — höjer tröskel vid loud sustain, oberoende av slew
- **Auto-tune-funktionen** — fortsätter föreslå deadband (suggested `maxFallPerSec` blir bara meta-info, inte längre applicerbart)

## Ändringar

### 1. `pi/src/piEngine.ts` — radera slew-blocket
Ta bort rad 932–944 (block 6b). `lastBrightness`-fältet kan stå kvar (skadar inte) eller städas bort.

### 2. `pi/src/piEngine.ts` — pensionera `maxRisePerSec` / `maxFallPerSec`
Behåll fälten i `LightCalibration` och `DEFAULT_CAL` för bakåtkompatibilitet med sparade profiler. Inget kod-stöd, men de bryter inte parsing.

### 3. `src/pages/PiMobile.tsx` — ta bort UI-slidrar
Ta bort "Anti-fladder ⤴ tak" och "Anti-fladder ⤵ tak" från `SLIDER_CONFIG`. Behåll "Anti-fladder deadband".

### 4. Auto-tune-panelen i `PiMobile.tsx`
Ta bort UI-knappen som applicerar suggested `maxFallPerSec` (panelen visar fortfarande deadband-förslag och `flickerScore`).

### 5. `pi/src/configServer.ts`
Profil-defaults för `maxRisePerSec` / `maxFallPerSec` kan stå kvar (oanvända). Ingen migration krävs.

## Latens efter ändringen

| Steg | Latens-tillägg |
|---|---|
| Anti-alias buffer | ~15 ms |
| EMA i tickInner | beror på releaseAlpha (~10–80 ms) |
| Slew | **0 ms** (borta) |
| Deadband | 0 ms (fryser bara output) |

Snabba kicks landar nu fullt utvecklade på första tick efter onset.

## Memory-uppdatering

Uppdatera `mem://pi/audio/anti-flicker-pipeline.md` så det reflekterar att slew är pensionerad och endast deadband + adaptiv onset finns kvar. Lägg till hänvisning till `mem://pi/audio/fft-anti-alias-buffer.md` som ersättningen för det slew-en löste.
