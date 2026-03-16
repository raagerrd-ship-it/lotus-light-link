

## Idé: Volym→Max-tabell — AGC som lär sig utan reset

### Koncept
Istället för att spara ett enda `agcMax + agcVolume`-par, spara en **lookup-tabell** som mappar volymintervall till observerade max-värden. AGC behöver aldrig resetta — vid volymändring slår den upp det historiska maxet för den volymen och använder det som golv.

### Hur det funkar
- Volymskalan (0–100) delas i t.ex. **buckets om 5** → 20 buckets
- Varje tick: `if (smoothed > table[bucket]) table[bucket] = smoothed` — monotont växande per bucket
- Vid volymändring: nytt bucket → hämta dess sparade max som golv
- Tabellen sparas i `localStorage` precis som nuvarande kalibrering
- **Ingen reset vid låtbyte behövs** — varje volymnivå har redan sitt "förväntade" max

### Ändringar

**1. `src/lib/engine/agc.ts`**
- Nytt interface `AgcVolumeTable`: `Record<number, number>` (bucket → max)
- `AgcState`: ersätt `peakMax` med referens till tabellen, behåll `max/min/bassMax/midHiMax` etc.
- Ny funktion `updateVolumeTable(table, bucket, smoothed)` 
- Ny funktion `getFloorForVolume(table, bucket)` — returnerar sparat max för bucketen, eller interpolerar från närliggande
- Ta bort `updateGlobalAgc`, `updateBandPeaks`, decay-konstanter

**2. `src/lib/engine/lightCalibration.ts`**
- Ersätt `agcMax/agcMin/agcVolume` med `agcVolumeTable: Record<number, number>`
- Migration: om gamla fält finns, konvertera till tabell-entry

**3. `src/lib/engine/lightEngine.ts`**
- Ta bort `agcLocked`, `trackStartTime`, `AGC_LEARN_DURATION_MS`
- `tick()`: beräkna bucket från `this.volume`, anropa `updateVolumeTable`, sätt `agc.max = Math.max(getFloorForVolume(...), agc.max)`
- `resetAgc()` → kan tas bort eller förenklas kraftigt (bara nollställ smoothing-variabler)
- Spara tabellen periodiskt (redan finns 10s-intervall)

### Risker / frågor
- **Bucket-storlek**: 5-stegs buckets (20 st) borde räcka. Finare = mer precision men mer data.
- **Interpolering**: Om en bucket saknar data, ta närmaste kända bucket × volymratio.
- **Första gången**: Alla buckets tomma → `max = 0.01` default, växer snabbt.
- **Olika rum/mikrofoner**: Tabellen är specifik för nuvarande setup. Om man byter rum/mikrofon borde man kunna nollställa tabellen (en "reset calibration"-knapp).

