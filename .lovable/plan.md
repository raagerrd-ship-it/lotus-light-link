## Mål
Eliminera frame-to-frame-hack i ljuset som uppstår när tick:en (50 Hz) stickprovar FFT-frames (~93 Hz). Lösningen är en kort rolling average (3 frames ≈ 32 ms) över bands-RMS i `pi/src/alsaMic.ts` — utan att röra `flux` (onset-detektion behöver skarpa transienter) och utan att röra EMA-smoothingen i `engine.tickInner` (den hanterar musikalisk mjukhet).

Latens-tillägg: ~10–20 ms peak-latens, väl under perceptuell tröskel (~50 ms). RAM-tillägg: ~36 bytes.

## Ändringar — endast `pi/src/alsaMic.ts`

### 1. Modulnivå-buffrar (direkt ovanför `let latestBands` på rad 206)
Lägg till tre pre-allokerade `Float32Array(3)` plus position/fill-räknare. Noll allokering i hot path.

```ts
const FFT_SMOOTH_WINDOW = 3;
const fftBassHistory = new Float32Array(FFT_SMOOTH_WINDOW);
const fftMidHiHistory = new Float32Array(FFT_SMOOTH_WINDOW);
const fftTotalHistory = new Float32Array(FFT_SMOOTH_WINDOW);
let fftHistoryPos = 0;
let fftHistoryFilled = 0;
```

### 2. Ersätt rå-tilldelningen i `processFFT` (rad 305–309)
Skriv in nya värden i ringbufferten, summera, dela med antal fyllda slots. `flux` passerar oförändrad.

```ts
fftBassHistory[fftHistoryPos] = rawBass;
fftMidHiHistory[fftHistoryPos] = rawMidHi;
fftTotalHistory[fftHistoryPos] = rawTotal;
fftHistoryPos = (fftHistoryPos + 1) % FFT_SMOOTH_WINDOW;
if (fftHistoryFilled < FFT_SMOOTH_WINDOW) fftHistoryFilled++;

let bassSum = 0, midHiSum = 0, totalSum_smooth = 0;
for (let i = 0; i < fftHistoryFilled; i++) {
  bassSum += fftBassHistory[i];
  midHiSum += fftMidHiHistory[i];
  totalSum_smooth += fftTotalHistory[i];
}
const invFilled = 1 / fftHistoryFilled;

latestBands.bassRms = bassSum * invFilled;
latestBands.midHiRms = midHiSum * invFilled;
latestBands.totalRms = totalSum_smooth * invFilled;
latestBands.flux = flux;  // skarp — onset-detektion behöver detta
```

### 3. Utöka `resetFluxState` (rad 334–336)
Nollställ även anti-alias-historiken så att tystnadsperioder inte blandas med ny data.

```ts
export function resetFluxState(): void {
  prevPower.fill(0);
  fftBassHistory.fill(0);
  fftMidHiHistory.fill(0);
  fftTotalHistory.fill(0);
  fftHistoryPos = 0;
  fftHistoryFilled = 0;
}
```

## Vad lämnas orört
- `engine.tickInner` EMA-smoothing — fortsätter att hantera musikalisk mjukhet ovanpå anti-alias-bufferten.
- `flux` — passerar rå till onset-detektorn (smoothing skulle döda kick-detektion).
- `processOnset`, dynamics, transient boost, color fade, BLE-output — oförändrat.
- Inga UI-ändringar, inga nya kalibreringsvärden, inga nya endpoints.

## Minnesnotering efteråt
Uppdatera `mem://pi/audio/anti-flicker-pipeline.md` (eller skapa ny `mem://pi/audio/fft-anti-alias-buffer.md`) med: 3-frame rolling average i alsaMic, flux exkluderad, ~32 ms fönster, latens-tillägg < 20 ms.
