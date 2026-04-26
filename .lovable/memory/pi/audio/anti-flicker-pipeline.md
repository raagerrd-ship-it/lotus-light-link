---
name: Anti-fladder pipeline (slew + deadband + adaptiv onset)
description: Tre stadier i piEngine.tickInner som dödar mikrojitter på loud-passager utan att förstöra attack — slew-rate-limit, perceptuell deadband (Weber), och dynamicCenter-driven onset-suppression
type: feature
---
För att eliminera fladder vid sustained loud-passager (heavy bass, distad gitarr, full mix) körs tre kompletterande filter EFTER dynamics + onsetBoost men FÖRE/under gamma i `pi/src/piEngine.ts`:

## 1. Slew-rate limiter (asymmetrisk, normaliserad/sek)
```ts
const dtSec = clamp(this.tickMs/1000, 0.005, 0.2);
const maxStep = (rising ? cal.maxRisePerSec : cal.maxFallPerSec) * dtSec;
energyNorm = clamp(energyNorm, lastBrightness ± maxStep);
```
Garanterar lugn rörelse oavsett insignal. Höga maxRise (8–20) släpper igenom attacker; lågt maxFall (1.5–5) är viktigast för att eliminera "pendling" i mättade passager.

## 2. Perceptuell deadband (Weber-Fechner)
```ts
const deadbandPct = cal.flickerDeadband * 100 * (0.5 + pct/100);
if (|pct - lastSentPct| < deadbandPct) pct = lastSentPct;
```
Skalas linjärt med nivå: ~0.5×base vid pct=0, ~1.5×base vid pct=100 — matchar att ögat märker större relativ ändring i mörker. Stale-write-mekanismen (`mem://pi/ble/stale-write-force`) håller fortfarande BLE-länken aktiv när pct fryser.

## 3. Adaptiv onset-suppression i `processOnset`
```ts
const suppression = dc > 0.5 ? 1 + (dc - 0.5) * 1.5 : 1;
const threshold = med * cal.onsetThreshold * suppression + 0.008;
```
När `dynamicCenter > 0.5` (loud sustain) höjs onset-tröskeln upp till +75%. Pulser triggar fortfarande på riktiga slag, men slutar kittla på sustained loud-passager där flux blir naturligt brusig.

## Cal-fält (LightCalibration + DEFAULT_CAL)
- `maxRisePerSec` (default 8.0, range 1–20)
- `maxFallPerSec` (default 2.5, range 0.5–10)
- `flickerDeadband` (default 0.02, range 0–0.08)

## Profil-defaults (sync mellan `pi/src/configServer.ts` DEFAULT_PROFILES och `src/pages/PiMobile.tsx` PRESET_CALS)
| Profil | maxRise/s | maxFall/s | deadband |
|---|---|---|---|
| Lugn   | 4.0  | 1.5 | 0.04 |
| Normal | 8.0  | 2.5 | 0.02 |
| Party  | 15.0 | 5.0 | 0.01 |
| Custom | 8.0  | 2.5 | 0.02 |

## State-fält (PiLightEngine)
- `lastBrightness` (0..1) — senast slew-begränsad energiNorm
- `lastSentPct` (-1 = oinit, annars 0..100) — senast UI/BLE-rapporterad pct för deadband-jämförelse

Bägge resetas i `setPlaying(false)`, `onBleConnected` (active mode), och `sanitizeState` (NaN-guard).

## Tuning-tips
- Fladder kvar på loud passager → sänk `maxFallPerSec` och/eller höj `flickerDeadband`
- Lampan känns trög på snabb release → höj `maxFallPerSec`
- Pulser drunknar i sustain → sänk `cal.onsetThreshold` (suppressionen lägger ändå på sin multiplikator)

## UI
Tre slidrar i `SLIDER_CONFIG` (PiMobile.tsx) under Attack/Release-blocket: "Anti-fladder ⤴ tak", "Anti-fladder ⤵ tak", "Anti-fladder deadband". Persisteras via `/api/profiles` PUT. Forward-kompat — gamla profiler får defaults via merge i `loadProfilesFile` och `mapStoredToCal`.
