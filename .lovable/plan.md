

## Problem
Auto-normaliseringen i `drawChart.ts` beräknar skalan per frame baserat på max i den synliga bufferten. Det eliminerar dynamisk kontrast mellan lugna och intensiva delar av låten.

## Lösning: Decaying peak-hold

Istället för att skala mot nuvarande max, använd ett **peak-hold med långsam decay**:

- Håll kvar det högsta `maxPct`-värdet som setts under låten
- Låt det sjunka långsamt (t.ex. 0.5% per frame) så att om en låt börjar lugnt ökar skalan gradvis
- Vid låtbyte (ny palette/track) nollställs peak-hold

### Ändringar

**`src/lib/drawChart.ts`**
- Exportera en `ChartScaler`-klass eller använd en modul-lokal variabel som håller `heldMax`
- Varje frame: `heldMax = max(heldMax * 0.997, currentMaxPct, 30)` — decay långsamt, golv på 30 så att tysta partier fortfarande syns
- Skala mot `heldMax` istället för `maxPct`

**`src/components/MicPanel.tsx`** (eller där chart ritas)
- Nollställ `heldMax` när `currentColor` ändras (= nytt spår/sektion)

Enkel implementation — en enda modul-lokal variabel + ~5 rader ändrade.

