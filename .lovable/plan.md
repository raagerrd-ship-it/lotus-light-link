

## Ändra Punch White-slidern

### Vad
Ändra Punch White-slidern så den går från **90% till 100%** i **0.5%-steg**, där **100% = av** (istället för nuvarande 0 = av, 0–100 i steg om 5).

### Ändringar

**1. `src/components/CalibrationOverlay.tsx`**
- Ändra slider-definitionen: `min: 90, max: 100, step: 0.5`
- Uppdatera description: `'100 = av. Ljusstyrka över detta → vit färg.'`
- Ändra bypass-värdet från `0` till `100` (av)

**2. `src/lib/engine/lightEngine.ts`**
- Ändra punch-logiken: `const isPunch = cal.punchWhiteThreshold < 100 && pct >= cal.punchWhiteThreshold;`

**3. `src/lib/engine/lightCalibration.ts`**
- Default `punchWhiteThreshold: 100` (av)
- Party-preset: `punchWhiteThreshold: 95` (eller liknande lämpligt värde i nya intervallet)
- Lugn-preset: behåll av (`100`)

