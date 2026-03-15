

## Analys av CalibrationOverlay

Jag har gått igenom koden noggrant. Den grundläggande realtids-synken fungerar korrekt:

- **Slider → `saveCalibration()` → `localStorage` + `CustomEvent('calibration-changed')` → MicPanel `calRef` uppdateras** ✓
- **Alla 14 användarrelevanta kalibreringsvärden har sliders** ✓ (AGC/latency är automatiska och ska inte ha sliders)
- **MixerFader pointer-drag, +/− knappar, snapping** ✓
- **Reset, BLE-hastighetstest, historik** ✓

### Problem att fixa

**1. Varje slider-drag sparar till molnet**
`update()` (rad 344-350) anropar `saveCalibration(next, deviceName)` utan `localOnly: true`. Vid snabb slider-dragning skickas dussintals cloud-upserts. Bör vara `localOnly: true` under interaktion, och en enda cloud-save vid stängning.

**2. Ingen cloud-save vid stängning**
`onClose` triggas utan att spara till molnet. All slider-justering stannar i localStorage men når aldrig databasen om man inte också kör BLE-hastighetstest.

**3. AGC-timer kan skriva över slider-värden**
MicPanel har en 10s-timer (rad 595-599) som läser `calRef.current`, lägger till AGC-värden, och skriver till localStorage. Men CalibrationOverlay har sin egen `cal` state som inte lyssnar på localStorage-ändringar. Om AGC-timern triggas mitt i slider-dragning skrivs AGC-värdena korrekt (de tar med nuvarande calRef som redan uppdaterats av custom event). Dock: om overlay öppnas **efter** att AGC lärt sig nya min/max, har overlay gammal AGC-data i sitt state — men det påverkar inte synliga sliders (AGC har inga sliders). Inget problem.

### Ändringar

**`src/components/CalibrationOverlay.tsx`**

1. Ändra `update()` att använda `localOnly: true`:
```tsx
const update = useCallback((key: keyof LightCalibration, value: number) => {
  setCal(prev => {
    const next = { ...prev, [key]: value };
    saveCalibration(next, conn?.device?.name, { localOnly: true });
    onCalibrationChange?.(next);
    return next;
  });
}, [conn?.device?.name, onCalibrationChange]);
```

2. Spara till molnet vid stängning — wrappa `onClose`:
```tsx
const handleClose = useCallback(() => {
  // Save to cloud once on close
  saveCalibration(cal, conn?.device?.name);
  onClose();
}, [cal, conn?.device?.name, onClose]);
```
Använd `handleClose` i header X-knappen.

3. `resetAll` bör också använda `localOnly: false` (redan gör det) — OK som det är, det är en engångsåtgärd.

