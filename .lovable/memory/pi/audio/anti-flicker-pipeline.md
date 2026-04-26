---
name: Anti-fladder pipeline (deadband + adaptiv onset)
description: Två kvarvarande filter i piEngine.tickInner mot mikrojitter — perceptuell deadband (Weber) på output och dynamicCenter-driven onset-suppression. Slew-rate-limitern är borttagen 2026-04-26 sedan anti-alias-bufferten i alsaMic tog över bruseliminering på källan.
type: feature
---
**Historik:** Pipelinen hade tidigare tre stadier (slew + deadband + adaptiv onset). Slew-rate limitern togs bort 2026-04-26 eftersom [anti-alias-bufferten i alsaMic](mem://pi/audio/fft-anti-alias-buffer) nu eliminerar frame-to-frame-bruset på källan. Slew-en gjorde då bara skada — bromsade kicks utan att tillföra något.

## Kvarvarande filter i `pi/src/piEngine.ts`

### 1. Perceptuell deadband (Weber-Fechner) — block 7b
```ts
const deadbandPct = cal.flickerDeadband * 100 * (0.5 + pct/100);
if (|pct - lastSentPct| < deadbandPct) pct = lastSentPct;
```
Skalas linjärt med nivå: ~0.5×base vid pct=0, ~1.5×base vid pct=100. Fryser BLE-skick på platta partier — ingen latens-kostnad. Stale-write-mekanismen (`mem://pi/ble/stale-write-force`) håller länken vid liv när pct fryser.

### 2. Adaptiv onset-suppression i `processOnset`
```ts
const suppression = dc > 0.5 ? 1 + (dc - 0.5) * 1.5 : 1;
const threshold = med * cal.onsetThreshold * suppression + 0.008;
```
När `dynamicCenter > 0.5` (loud sustain) höjs onset-tröskeln upp till +75%.

## Cal-fält
- `flickerDeadband` (default 0.02, range 0–0.08) — aktivt fält
- `maxRisePerSec` / `maxFallPerSec` — **pensionerade** men kvar i typ + DEFAULT_CAL för bakåtkomp med sparade profiler. Ingen runtime-effekt.

## Profil-defaults (kvarvarande aktiva fält)
| Profil | deadband |
|---|---|
| Lugn   | 0.04 |
| Normal | 0.02 |
| Party  | 0.01 |
| Custom | 0.02 |

## State-fält
- `lastSentPct` (-1 = oinit, annars 0..100) — senast UI/BLE-rapporterad pct för deadband-jämförelse
- `lastBrightness` — kvar men oanvänd efter slew-borttagning

Resetas i `setPlaying(false)`, `onBleConnected` (active mode), och `sanitizeState` (NaN-guard).

## UI
En slider i `SLIDER_CONFIG` (PiMobile.tsx): "Anti-fladder deadband". Auto-tune-panelen föreslår enbart deadband (en knapp "✓ Tillämpa deadband-förslag").

## Tuning-tips
- Fladder kvar på loud passager → höj `flickerDeadband` eller höj `releaseAlpha` i Softness
- Pulser drunknar i sustain → sänk `cal.onsetThreshold`
