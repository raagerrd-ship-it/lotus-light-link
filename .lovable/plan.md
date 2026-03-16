

## Lägg till Smoothing-slider (utöver Attack/Release)

### Koncept
Attack/Release styr hur snabbt signalen följer upp/ner. Den nya **Smoothing**-slidern lägger ett extra utjämningssteg *efter* attack/release — ett enkelt moving-average-filter som jämnar ut kurvan utan att ändra reaktionshastigheten. Tänk det som att dra en pensel över en redan tecknad kurva.

### Ändringar

**1. `src/lib/engine/lightCalibration.ts`**
- Lägg till `smoothing: number` i `LightCalibration` (0–100, default 0 = ingen extra utjämning)
- Lägg till i `DEFAULT_CALIBRATION`

**2. `src/lib/engine/brightnessEngine.ts`**
- Ny exporterad funktion `extraSmooth(history: number[], newVal: number, windowSize: number): { smoothed: number; history: number[] }` 
- Implementerar ett enkelt sliding-window average: `windowSize` beräknas från `smoothing` (0 → 1 sample = bypass, 100 → ~20 samples)

**3. `src/lib/engine/lightEngine.ts`**
- Tre nya historik-buffrar: `smoothHistoryBass`, `smoothHistoryMidHi`, `smoothHistoryBrightness`
- Efter existerande `smooth()`-anropen (rad 295-296), kör `extraSmooth()` på `smoothedBass` och `smoothedMidHi`
- Alternativt: kör `extraSmooth()` på slutlig `pct` efter `computeBrightnessPct` (enklare, en buffer)
- `windowSize` = `Math.max(1, Math.round(cal.smoothing / 5))` → 1–20 samples
- Reset buffrar i `resetSmoothing()` och `destroy()`

**4. `src/components/CalibrationOverlay.tsx`**
- Ny slider i gruppen "Dynamik":
  - `key: 'smoothing'`, label: "Smoothing", shortLabel: "Smth", min: 0, max: 100, step: 1, unit: "%"
  - Description: "Extra utjämning av ljuskurvan. 0 = av, högre = mjukare."
- Bypass-värde: `smoothing: 0`

