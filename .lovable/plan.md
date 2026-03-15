

## Ta bort BLE-kalibrering, historik och rensa bort oanvända funktioner

### Ändringar

**`src/components/CalibrationOverlay.tsx`**
- Ta bort `BleSpeedSection`-komponenten (rad 158-280) och alla dess konstanter/typer
- Ta bort `HistorySection`-komponenten (rad 282-318)
- Ta bort state: `showBle`, `showHistory`
- Ta bort hela collapsible-sektionen i botten (rad 424-445) — den renderade bara BLE-test och historik
- Rensa imports: ta bort `saveBleSpeedToCloud`, `listCalibrationsFromCloud`, `deleteCalibrationFromCloud`, `LatencyResults`, `setBleMinInterval`, `Trash2`, `RefreshCw`, `Play`, `Check`, `Square`, `ChevronDown`, `ChevronUp`

**`src/lib/lightCalibration.ts`**
- Ta bort `saveBleSpeedToCloud()` (rad 140-147)
- Ta bort `listCalibrationsFromCloud()` (rad 149-170)
- Ta bort `deleteCalibrationFromCloud()` (rad 172-179)
- Behåll `loadCalibrationFromCloud()` och `_upsertCloud()` — dessa används fortfarande av Index.tsx för att ladda/spara kalibrering vid BLE-anslutning

**`src/pages/Index.tsx`**
- Ta bort `setBleMinInterval`-import och anropet på rad 244-246 (BLE-intervallet är redan hårdkodat till 50ms i bledom.ts)
- Behåll `loadCalibrationFromCloud` — den laddar kalibreringsvärden (slider-inställningar) från molnet vid anslutning

