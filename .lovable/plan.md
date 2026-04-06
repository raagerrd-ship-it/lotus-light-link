

## Dynamiska AGC quiet-tick thresholds

### Problem
Quiet-tick thresholds är hårdkodade i tre ställen med olika värden:
- `src/lib/engine/agc.ts`: 16 / 40 (antar 8Hz)
- `pi/src/piEngine.ts`: 66 / 165 (antar 33Hz)

Om tickMs ändras runtime (via slider/API) stämmer inte tidsintervallen längre.

### Lösning
Gör `QUIET_TICKS_MEDIUM` och `QUIET_TICKS_FAST` till funktioner av tickMs istället för konstanter.

### Ändringar

**1. `src/lib/engine/agc.ts`**
- Ta bort hårdkodade `QUIET_TICKS_MEDIUM = 16` och `QUIET_TICKS_FAST = 40`
- Exportera tidskonstanter i millisekunder: `QUIET_MS_MEDIUM = 2000`, `QUIET_MS_FAST = 5000`
- Lägg till helper: `export function quietTickThresholds(tickMs: number): { medium: number; fast: number }`
- Uppdatera `updateRunningMax` att ta `tickMs` som parameter och beräkna thresholds internt

**2. `src/lib/engine/brightnessEngine.ts`**
- Skicka `tickMs` till `updateRunningMax`-anropet

**3. `pi/src/piEngine.ts`**
- Ta bort lokala hårdkodade `QUIET_TICKS_MEDIUM = 66` / `QUIET_TICKS_FAST = 165`
- Använd `quietTickThresholds(this.tickMs)` från agc-modulen (eller beräkna inline med samma formel)

Totalt ~15 rader ändrade, ingen ny fil, ingen beteendeförändring vid nuvarande tick-rates — bara korrekt vid framtida ändringar.

