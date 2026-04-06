

## Onset Detection med Spectral Flux Peak-Picking

### Bakgrund
Nuvarande metod: rå spectral flux → smoothing → normalisering mot adaptivt max → 15% boost. Detta ger en *kontinuerlig* transient-signal, inte diskreta "slag". Resultat: boost smetas ut över tid istället för att ge snärtiga ljuspulser.

**Peak-picking** ger istället binära onset-händelser (ja/nej per tick) genom att jämföra flux mot en adaptiv tröskel och kräva lokal maxima. CPU-kostnaden är försumbar — enbart aritmetik på det redan beräknade flux-värdet.

### Implementering

**1. Ny modul: `src/lib/engine/onsetDetector.ts`** (~60 rader)
- Cirkulär buffer med de senaste N flux-värdena (N ≈ 7, ~175ms vid 25ms tick)
- Adaptiv tröskel = `median(buffer) * multiplier + offset`
  - `multiplier` = 1.5, `offset` = liten konstant för att undvika falska triggers i tystnad
- Onset = `flux[current] > threshold` OCH `flux[current] >= flux[current-1]` (lokal peak)
- Exporterar `createOnsetState()`, `detectOnset(state, flux) → boolean`
- Tick-rate-oberoende: bufferstorleken anpassas efter `tickMs` (mål ~175ms lookback)

**2. Uppdatera `src/lib/engine/lightEngine.ts`**
- Importera onset detector, skapa state i konstruktorn
- Ersätt nuvarande `smoothedFlux * 0.15` boost med:
  - Vid onset: instant boost (t.ex. +20% brightness) som avtar exponentiellt per tick
  - Decay: `boostLevel *= pow(decayPerSec, tickMs/1000)` (decay ~90%/s)
- Behåll `transientBoost`-toggle (styr om onset-boost appliceras)

**3. Uppdatera `pi/src/piEngine.ts`**
- Kopiera/inline samma onset-logik (Pi har redan inline-mönster)
- Identisk matematik som browser-versionen

**4. Uppdatera `pi/src/alsaMic.ts`**
- Ingen ändring behövs — `flux` beräknas redan korrekt i FFT-steget

### Pi Zero 2 prestanda
- Enda nya beräkning per tick: sortera 7 tal (median) + 2 jämförelser = ~microsekunder
- Ingen extra FFT, ingen extra buffert av betydelse
- Fullt genomförbart

### Resultat
Ljuset får snärtiga, diskreta "blixtar" på trumslag/transienter istället för en utsmord kontinuerlig boost.

