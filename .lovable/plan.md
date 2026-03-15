

## Plan: Exponera alla dolda bearbetningssteg som sliders

### Nya sliders (5 st)

| Slider | Grupp | Range | Default | Syfte |
|--------|-------|-------|---------|-------|
| Hi-shelf gain | Frekvens | 0–12 dB | 6 | Diskantkompensation för mic |
| BPM-release | Dynamik | 0–100% | 80 | Hur mycket BPM skalar release (0=av) |
| Saturation boost | Palett | 0.5–2.0 | 1.0 | Färgmättnad |
| Band AGC attack | AGC | 0.02–0.5 | 0.15 | Hur snabbt per-band AGC fångar toppar |
| Band AGC decay | AGC | 0.990–0.999 | 0.997 | Hur snabbt per-band AGC släpper |

### Filer att ändra

**1. `src/lib/lightCalibration.ts`**
- Lägg till 5 nya fält i `LightCalibration`: `hiShelfGainDb`, `bpmReleaseScale`, `saturationBoost` (redan finns men saknar slider), `bandAgcAttack`, `bandAgcDecay`
- Sätt defaults i `DEFAULT_CALIBRATION`

**2. `src/components/CalibrationOverlay.tsx`**
- 5 nya `SliderDef`-entries i rätt grupper
- Hi-shelf → Frekvens, BPM-release → Dynamik, Saturation → Palett, Band AGC → ny grupp "AGC"

**3. `src/components/MicPanel.tsx`**
- Rad 334: Byt `hiShelf.gain.value = 6` → läs från `cal.hiShelfGainDb` (uppdatera dynamiskt via ref)
- Rad 390-393: Byt hårdkodad bpmReleaseFactor-logik → skala med `cal.bpmReleaseScale / 100`
- Rad 444-445: Byt `BAND_AGC_ATTACK = 0.15` och `BAND_AGC_DECAY = 0.997` → `cal.bandAgcAttack` och `cal.bandAgcDecay`
- `applyColorCalibration` använder redan `saturationBoost` från cal, så den fungerar automatiskt

### Beteende vid "allt på neutral"
Med alla nya sliders på default + befintliga på neutral → signalkedjan är transparent förutom volymkompensation (AGC). Sätter man Band AGC attack/decay till extremvärden kan man i princip göra den passiv också.

