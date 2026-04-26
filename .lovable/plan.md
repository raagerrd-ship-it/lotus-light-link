## Varför fladdrar lampan i tunga partier?

I täta mixar (heavy bass, distad gitarr, sustain-heavy passager) händer tre saker samtidigt i er nuvarande pipeline:

1. **RMS-bruset blir större** — när medelnivån ligger på t.ex. 0.7 kan bin-till-bin-variationen lätt vara ±0.05 mellan ticks.
2. **Dynamics-expansionen förstärker bruset** — `applyDynamics` multiplicerar avvikelsen från `dynamicCenter` med upp till 1.5×, så ±0.05 blir ±0.075.
3. **Onset-detektorn triggar oftare på sustained energi** — spectral flux blir ojämn när hela spektrumet är "fullt", vilket lägger på korta pulser ovanpå redan hög nivå.

Resultat: brightness pendlar t.ex. mellan 78% och 92% flera gånger per sekund → synligt fladder. Ert nuvarande release-EMA (`releaseAlpha=0.15`) släpper för snabbt på höga nivåer för att dölja det.

## Hur gör professionella system?

Studio/stage-controllers (grandMA, Hog, Madrix, Resolume) och kommersiella produkter (Philips Hue Sync, Nanoleaf Rhythm, LIFX Beam) använder typiskt en **kombination av 4–5 tekniker** — inte bara EMA-smoothing:

| Teknik | Vad den löser |
|---|---|
| **Asymmetrisk slew-rate-limit** | Hård tak på "max % förändring per ms" — t.ex. `≤ 8%/100ms` på release. EMA jämnar, slew-limit *garanterar* lugn rörelse oavsett insignal. |
| **Hysteres / Schmitt-trigger** | Output ändras inte alls om |Δ| < deadband (t.ex. 2%). Eliminerar mikrojitter helt på sustain. |
| **Perceptuell deadband (Weber-Fechner)** | Ögat märker ~5% relativ ljusändring på höga nivåer, ~1% på låga. Deadband skalas med nivå: större deadband när det är ljust. |
| **Onset-suppression vid hög sustain** | När `dynamicCenter > 0.6` (= låten är redan loud), höj onset-tröskeln med 1.5× — pulser ska sticka ut, inte addera flutter ovanpå mättnad. |
| **Median-filter på output** | 3-tap median istället för EMA i sista steget — eliminerar enstaka outliers utan att förstöra attack. |
| **Fixed update rate till driver** | Vissa system kör output på exakt 30/50 Hz med Z-order priority, så att korta bursts inte hinner skickas. (Ni har redan tickMs-cap.) |

## Plan: implementera 3 av dessa, runtime-tunbara

Jag föreslår vi börjar konservativt med de tre mest effektiva, som lägger sig **efter** dynamics men **före** gamma — så Attack/Release-känslan bevaras:

### 1. Brightness slew-rate limiter (asymmetrisk)
Lägg till två cal-fält:
- `maxRisePerSec` (default `8.0` = 800%/sek, dvs nästan obegränsad attack — pulser släpps igenom)
- `maxFallPerSec` (default `2.5` = 250%/sek, dvs full→0 tar 400ms minimum)

I `tickInner` efter dynamics + onsetBoost, före gamma:
```ts
const dt = tickMs / 1000;
const maxStep = energyNorm > lastBrightness ? cal.maxRisePerSec * dt : cal.maxFallPerSec * dt;
energyNorm = clamp(energyNorm, lastBrightness - maxStep, lastBrightness + maxStep);
```

### 2. Perceptuell hysteres (deadband)
Ett cal-fält: `flickerDeadband` (default `0.02`, range `0–0.08`).

Skala deadband med nivå (Weber): `effectiveDB = flickerDeadband * (0.5 + lastBrightness)`.
Om `|energyNorm - lastSentBrightness| < effectiveDB` → behåll `lastSentBrightness` istället för att skicka nytt värde. Stale-write-mekanismen (`mem://pi/ble/stale-write-force`) ser fortfarande till att länken hålls vid liv var 400ms.

### 3. Adaptiv onset-suppression
När `dynamicCenter > 0.5`, multiplicera den effektiva onset-tröskeln med `1 + (dynamicCenter - 0.5) * 1.5`. Inga nya cal-fält — använder befintlig `onsetThreshold` som baseline. Pulser triggar fortfarande på riktiga slag, men slutar kittla på sustained loud-passager.

### 4. UI: ny accordion-sektion "Anti-fladder" i PiMobile
Tre slidrar:
- **Max stigning** (1.0–20.0/s) — högre = snabbare attack
- **Max fall** (0.5–10.0/s) — lägre = mjukare release-tak
- **Deadband** (0–0.08) — högre = mer stillastående output på sustain

Lägger sig under befintliga "Mjukhet/Attack/Release"-blocket. Forward-kompat: gamla profiler får defaults via merge i `loadProfilesFile` och `loadCalibration` precis som onset-fälten.

## Filer som ändras

- `pi/src/piEngine.ts` — nya fält i `LightCalibration` + `DEFAULT_CAL`, ny logik i `tickInner` (slew-limiter), state `lastBrightness`, adaptiv onset-tröskel i `processOnset`.
- `pi/src/configServer.ts` — DEFAULT_PROFILES uppdateras för Lugn/Normal/Party/Custom, merge-default i `loadProfilesFile` + `loadCalibration`.
- `src/pages/PiMobile.tsx` — `SLIDER_CONFIG` får tre nya rader, `PRESET_CALS` per profil.
- Ny memory-fil: `mem://pi/audio/anti-flicker-pipeline` med profil-defaults och tuning-tips.

## Profil-defaults (förslag)

| Profil | maxRise/s | maxFall/s | deadband | onsetThreshold |
|---|---|---|---|---|
| Lugn   | 4.0  | 1.5 | 0.04 | 2.0 |
| Normal | 8.0  | 2.5 | 0.02 | 1.8 |
| Party  | 15.0 | 5.0 | 0.01 | 1.6 |

## Vad vi INTE gör i detta steg

- **Median-filter**: skjuts till nästa iteration om slew+deadband inte räcker — det adderar 1 tick latens.
- **Ändra FFT/hop**: pipeline ligger redan på 100Hz vilket är bra; flytta inte den ratan.
- **Auto-detektion av "tung passage"**: vi exponerar bara dynamicCenter-suppression, ingen ML/heuristik utöver det.

Efter implementation testar du i en låt som fladdrar idag → justera Max fall nedåt och Deadband uppåt tills lampan känns "musikalisk men stabil".