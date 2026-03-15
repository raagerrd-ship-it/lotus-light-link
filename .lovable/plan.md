

## Problem

Debug overlay visar `lastWriteMs` (bara BLE-skrivtiden) men inte hela kedjans tid (mic → process → BLE write klar). Du vill se ett **flytande max-värde** som resettas var 5:e sekund, för att snabbt avgöra om intervallet är för aggressivt.

## Lösning

### 1. `src/lib/bledom.ts` — Lägg till peak-tracking

Ny state: `_peakTotalMs` och `_peakResetTime`. Uppdatera i `_flush` efter write: `_peakTotalMs = max(_peakTotalMs, writeMs)`. Reset var 5:e sekund. Exponera via `BleWriteStats`:

```
peakWriteMs: number   // flytande max BLE-write-tid, reset var 5s
```

Gör samma sak i `PipelineTimings` — tracka `peakTotalTickMs` (hela kedjan mic→send). Uppdatera i `setPipelineTimings` med samma 5s-fönster.

Exponera ny funktion `getPipelinePeak(): number` som returnerar max `totalTickMs` senaste 5s.

### 2. `src/components/DebugOverlay.tsx` — Visa i BLE OUTPUT

Ersätt nuvarande `queue:`-rad med en tydligare rad:

```
intervall: 25ms │ peak: 18ms ✓
```

- Visar satt intervall och peak pipeline-tid sida vid sida
- **Grön** om peak < intervall (marginal finns)
- **Gul** om peak > 80% av intervall (nära gränsen)  
- **Röd** om peak ≥ intervall (gasar för mycket)

Behåll `w/s` och `err` på separat rad.

### 3. Props

Ny prop till DebugOverlay: `pipelinePeakMs: number | null`. MicPanel/Index läser `getPipelinePeak()` i sin UI-uppdateringsloop och skickar ner.

### Resultat

En rad i debug som direkt svarar: "hinner vi?" — utan att behöva tolka flera värden.

