

## Plan: Sonos-volymkalibrering som alternativ till AGC

### Koncept
Tre gain-lägen via AGC-knappen (cyklisk toggle):
1. **AGC** (auto) — nuvarande beteende, normaliserar automatiskt
2. **VOL** (volymkalibrering) — beräknar gain från Sonos-volym med 1-punkts kalibrering
3. **MAN** (manuell) — fast gain, ingen automatik

### Volymkalibrering: hur det fungerar
Användaren ställer in gain manuellt vid en viss Sonos-volym och trycker "kalibrera". Systemet sparar `{ volume, gain }` som referenspunkt. Vid volymändringar extrapoleras gain med en perceptuell power-kurva: `gain = refGain * (refVolume / currentVolume) ^ 2.5`. Sparas i localStorage.

### Tekniska ändringar

**`src/pages/Index.tsx`**
- Ersätt `agcEnabled: boolean` med `gainMode: 'agc' | 'vol' | 'manual'` (localStorage-sparad)
- AGC-knappen cyklar mellan de tre lägena (ikon ändras: Activity → Volume2 → SlidersHorizontal)
- Ny state `volCalibration: { volume: number, gain: number } | null` (localStorage)
- Skicka `gainMode`, `sonosVolume`, `volCalibration` som props till MicPanel
- Visa kalibrera-knapp (Crosshair-ikon) bredvid AGC-knappen när `gainMode === 'vol'` och volymdata finns

**`src/components/MicPanel.tsx`**
- Nya props: `gainMode`, `sonosVolume`, `volCalibration`
- I `sampleEnergy()` (rad ~376-383), brancha på gainMode:
  - `'agc'`: nuvarande AGC-logik
  - `'vol'`: `effectiveGain = calibration.gain * (calibration.volume / sonosVolume) ^ 2.5`
  - `'manual'`: fast `effectiveGain = 1` (ingen normalisering)

**`src/components/DebugOverlay.tsx`**
- Visa gainMode som `agc` / `vol (ref 40%)` / `manual`

### UI-flöde
1. Användaren spelar musik vid önskad volym
2. Byter till VOL-läge via AGC-knappen
3. Justerar max-brightness-slidern tills ljuset ser bra ut
4. Trycker kalibrera-knappen → sparar `{ volume: currentSonosVolume, gain: currentAgcAvg }`
5. Vid volymändring anpassas gain automatiskt

