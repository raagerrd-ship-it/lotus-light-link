

## Hårdkoda Hi-shelf EQ till 6 dB

### Ändringar

**1. `src/pages/PiMobile.tsx`**
- Ta bort `hiShelfGainDb` från `Cal`-typen och alla preset-objekt
- Ta bort slider-blocket (rad ~375–383)
- Ta bort `hiShelfGainDb` från save-payload och hydrate-logiken
- Hårdkoda `hiShelfGainDb: 6` i save-anropet

**2. `src/lib/engine/lightCalibration.ts`**
- Behåll `hiShelfGainDb: 6` i `DEFAULT_CALIBRATION` (används av lightEngine)
- Ingen ändring behövs — värdet är redan 6

**3. `src/lib/engine/lightEngine.ts`**
- Byt `this.cal.hiShelfGainDb` → konstant `6` för hi-shelf gain
- Alternativt: behåll som är, den läser alltid 6 från default

**4. `pi/src/piEngine.ts`**
- Hårdkoda `setHiShelfGain(6)` istället för `setHiShelfGain(this.cal.hiShelfGainDb)`
- Ta bort `hiShelfGainDb` från cal-typen om den inte längre skickas

**5. `pi/src/alsaMic.ts`**
- Ta bort `setHiShelfGain()` export — sätt `hsGain = Math.pow(10, 6/20)` som fast konstant
- Ta bort `hiShelfGainDb` variabel

**6. `src/components/CalibrationOverlay.tsx`**
- Ta bort `hiShelfGainDb: 0` override i test-kalibrering (rad ~383), låt default gälla

### Sammanfattning
6 filer ändras. Slutresultat: hi-shelf EQ är alltid 6 dB, ingen slider synlig, mindre kod att underhålla.

