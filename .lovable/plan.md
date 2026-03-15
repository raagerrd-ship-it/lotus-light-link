

## Presets: Lugn, Normal, Party, Custom

Fyra preset-knappar i headern med uppdaterade namn och profiler.

### Preset-profiler

- **Lugn** — Långsam attack, hög release, komprimerad dynamik. Mjukt och avslappnat ljus.
- **Normal** — Default-kalibrering. Balanserat.
- **Party** — Snabb attack, expanderad dynamik, punch white på. Maximalt reaktivt.
- **Custom** — Startar som Normal, men uppdateras varje gång man sparar i Kalibrering.

### Ändringar

**1. `src/lib/lightCalibration.ts`**
- Lägg till `BUILT_IN_PRESETS` med fyra namngivna presets (Lugn, Normal, Party, Custom) och deras `LightCalibration`-värden.
- `getPresets()` — returnerar sparade presets från `localStorage` (eller defaults).
- `savePresetCalibration(name, cal)` — sparar kalibrering under preset-namn.
- `getActivePreset()` / `setActivePreset(name)` — hanterar vilken preset som är aktiv.

**2. `src/pages/Index.tsx`**
- State för `activePreset`.
- Fyra pill-knappar i headern (visas när BLE anslutet).
- Tryck → laddar presetens kalibrering, markerar den som aktiv.

**3. `src/components/CalibrationOverlay.tsx`**
- Tar emot `activePreset` + `onPresetSave` props.
- Spara-knappen skriver till aktiv preset (alltid "Custom" om man ändrat manuellt, eller den aktiva).
- Visar aktiv preset i headern: "Mixer — Lugn".

### Header-layout
```text
[BT] DEVICE   [Lugn] [Normal] [Party] [Custom]   [⚙] [⏻]
```

