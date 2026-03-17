

## Lägg till "Brightness Floor" slider (0–10%)

### Ändringar

**1. `src/lib/engine/lightCalibration.ts`** — Ny property `brightnessFloor: number` (default `0`) i `LightCalibration` och `DEFAULT_CALIBRATION`.

**2. `src/lib/engine/brightnessEngine.ts`** — I `computeBrightnessPct`, efter `pct` beräknas, applicera golvet:
```typescript
const floor = cal.brightnessFloor ?? 0;
const pct = Math.max(floor, Math.round(rawPct * 100));
```
Utöka `cal`-picken med `brightnessFloor`.

**3. `src/components/CalibrationOverlay.tsx`** — Ny slider i SLIDERS-arrayen (grupp "Dynamik"):
```
{ key: 'brightnessFloor', label: 'Golv', shortLabel: 'Floor',
  min: 0, max: 10, step: 1, unit: '%', group: 'Dynamik',
  description: 'Lägsta brightness. Ljuset går aldrig under detta värde.' }
```
Bypass-värde: `0`.

