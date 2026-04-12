

## Plan: Diagnostik → "Spela in & visa graf"

### Koncept
Ersätt alla realtids-staplar och tabellvärden i diagnostikpanelen med en enda **"Starta diagnos"**-knapp. Vid tryck spelar Pi:n in 5 sekunder av signaldata och returnerar det, sedan ritas en interaktiv graf med två kurvor: **Input (post-gain RMS)** och **Output (brightness %)** över tid.

### Backend (Pi)

**Ny endpoint `POST /api/diagnostics/record`** i `pi/src/configServer.ts`:
- Startar en 5-sekunders inspelning
- Varje engine-tick samplar: `{ t, inputRms: rawRms, bassRms, outputPct: brightnessPct }`
- Lagrar i en ringbuffer (~500 samples á 10ms)
- Returnerar hela arrayen som JSON när klart
- Endpoint returnerar 409 om inspelning redan pågår

**Ny metod `startRecording(durationMs)` / `getRecording()`** i `pi/src/piEngine.ts`:
- I `tickInner()`: om recording pågår, pusha snapshot till array
- Sampla max var 10ms (1 av ~3 ticks) för rimlig datamängd

### Frontend (UI)

**Ersätt `DiagnosticsPanel`** i `src/pages/PiMobile.tsx`:
- Visa en "Starta diagnos"-knapp (+ 5s nedräkning under inspelning)
- Efter inspelning: rendera en **tidsserie-graf** med `<canvas>` (ren Canvas 2D, inget externt lib)
- Två kurvor: blå = Input RMS (post-gain), orange = Output brightness
- X-axel = tid (0–5s), Y-axel = normaliserat 0–1
- Behåll möjlighet att köra ny inspelning

### Filer som ändras
1. `pi/src/piEngine.ts` — lägg till recording-logik + metoder
2. `pi/src/configServer.ts` — ny POST-endpoint
3. `src/pages/PiMobile.tsx` — ersätt DiagnosticsPanel med knapp + canvas-graf

