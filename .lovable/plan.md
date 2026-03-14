

## Problemet

Ljusstyrkan i den bakade kurvan (`brightness_curve`) beräknas med en **helt annan algoritm** än live mic-läget. Mic-läget använder enkel AGC (running min/max + EMA + dynamicDamping + absoluteFactor), medan den bakade kurvan använder CIE-perceptuell mappning, per-band envelope followers, ADSR-kuvert, sektions-mood-floors/ceilings, noise gates och andningseffekter. Det är därför resultaten inte matchar — de är två helt separata system.

## Lösning: Baka med samma algoritm som mic-läget

Ersätt `computeBrightnessCurve` i `process-songs` med en funktion som kör **exakt samma AGC-pipeline** som `MicPanel` mic-mode över de inspelade `energy_curve`-samples. Sedan läggs konserteffekter (strobes, blackouts, palette-rotation) på som **additiva modifierare** ovanpå, inte som kärnan.

### Steg

1. **Ny `computeBrightnessCurve`** i `process-songs/index.ts`:
   - Tar `energy_curve` + `calibration_snapshot` (som inkluderar sparad AGC-state: `agcMax`, `agcMin`, `agcPeakMax`)
   - Kör sample-för-sample genom identisk logik:
     - EMA smoothing med `attackAlpha` / `releaseAlpha`
     - Learned AGC: running `agcMax` (decay 0.995), `agcMin` (rise 0.9999)
     - `agcPeakMax` tracking (decay 0.9998)
     - `absoluteFactor = agcMax / agcPeakMax` → skapar dynamiskt tak
     - `dynamicDamping` power curve
     - Resultat: `pct = minBrightness + normalized * (effectiveMax - minBrightness)`
   - Denna bas-brightness bör vara **identisk** med vad mic-läget producerade live

2. **Konserteffekter som additiv lager** (behålls men som ±modifiers):
   - Beat-puls: `+pulseBoost` (oförändrad logik)
   - Strobe-markering i data (flagga, inte brightness-ändring — hanteras i klienten)
   - Build-up blackout: `*= (1 - blackoutProgress)` vid >0.9
   - Sektionsbyten: flash `+30` vid hårda transitions
   - Ta bort: CIE-mappning, per-band EMA, noise gate, section mood floor/ceil, ADSR, breathing

3. **Volymkompensation** vid uppspelning (redan finns i klienten) fungerar automatiskt eftersom basen nu matchar inspelad volym.

4. **Rebake** alla låtar efter deploy.

### Filer som ändras

- `supabase/functions/process-songs/index.ts` — ersätt `computeBrightnessCurve` med mic-identisk AGC-pipeline + additiva konserteffekter

### Resultat

- Bakad kurva = exakt samma ljusstyrka som mic-läget producerade vid inspelning
- Konserteffekter (strobes, blackouts, palette-rotation) adderas ovanpå
- Inget mer mismatch mellan live och bakat

