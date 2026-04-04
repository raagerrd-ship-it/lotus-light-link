

## Lägg till RMS-gate slider + ta bort BLE delta-gate

### Två ändringar i samma plan

**1. Ta bort BLE delta-gate** i `src/lib/engine/bledom.ts`:
- Radera `maxDelta`-beräkningen och `if (maxDelta < 8)` early return i `sendToBLE`
- Behåll `_lastR/_lastG/_lastB/_lastBr` och non-reentrant guard

**2. Lägg till `rmsGate`-parameter**:

**`src/lib/engine/lightCalibration.ts`**:
- Lägg till `rmsGate: number` i `LightCalibration`-interfacet
- Default: `rmsGate: 5` i `DEFAULT_CALIBRATION` (representerar 5%)

**`src/lib/engine/lightEngine.ts`** (rad ~332):
- Ändra `rmsChange < 0.05` → `rmsChange < cal.rmsGate / 100`

**`src/components/CalibrationOverlay.tsx`**:
- Lägg till en global slider (i samma sektion som ⚡/👁-toggles):
  - Label: **RMS Gate**
  - Key: `rmsGate`
  - Min: 0, Max: 20, Step: 1
  - Enhet: `%`
  - Beskrivning: "Tröskel för att skippa beräkning vid oförändrad mic-input. Högre = fler ticks skippas (lägre CPU). Lägre = mjukare övergångar."
- Bypass-värde: 0 (ingen gate)

### Resultat

Användaren kan i realtid justera hur känslig RMS-gaten är, från 0% (aldrig skippa) till 20% (aggressiv filtrering), direkt i mixern.

