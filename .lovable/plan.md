

## Flytta skip-logik till mikrofoninput

### Problem
Skip-logiken (delta-gate) sitter idag efter hela pipelinen (FFT → smooth → AGC → brightness → color → **skip-check**). All beräkning görs i onödan om resultatet ändå skippas.

### Lösning: RMS-gate direkt efter FFT

Direkt efter `computeBands()` (rad 310) jämför vi `totalRms` mot förra tickens värde. Om skillnaden är under en tröskel → skippa resten av pipelinen och emit:a förra tickens data.

### Vad som händer

**`src/lib/engine/lightEngine.ts`**:
1. Ny instansvariabel `lastTotalRms: number = 0` och `lastTickData: TickData | null`
2. Efter `computeBands()` (rad 310), beräkna `rmsChange = Math.abs(bands.totalRms - this.lastTotalRms) / Math.max(this.lastTotalRms, 0.001)`
3. Om `rmsChange < 0.05` (5% relativ förändring) **och** det finns `lastTickData`:
   - Öka `debugData.bleSkipDeltaCount++`
   - Re-emit `lastTickData` (så chart/UI fortsätter fungera)
   - `return` — skippa smooth, AGC, brightness, color, BLE
4. Annars: kör pipelinen som vanligt, spara `this.lastTotalRms = bands.totalRms` och `this.lastTickData = tickData`

### Viktigt designbeslut

- AGC-decay **pausas** under skippade ticks — detta är OK eftersom om mic-input inte ändrats har AGC-state inte heller behövt ändras
- Delta-gate i `sendToBLE` (bledom.ts) behålls som backup — den fångar fall där pipelinen körs men BLE-output ändå är identisk
- Tröskeln 5% är konservativ — kan justeras via calibration senare

### Resultat

```text
Nuvarande:  FFT → Smooth → AGC → Brightness → Color → BLE(skip?) → emit
Nytt:       FFT → RMS-GATE → [Smooth → AGC → Brightness → Color → BLE → emit]
                    ↑ skip här om mic-input oförändrad
```

Sparar ~90% av CPU på ticks där mikrofonen inte fångar ny energi (t.ex. tyst passage, hållna toner).

