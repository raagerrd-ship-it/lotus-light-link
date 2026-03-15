

## Ta bort palettrotation och crossfade — kör bara dominant färg

Ändringen är enkel: extrahera bara den mest dominanta färgen från albumart och använd den hela låten. All rotation, crossfade och palettstöd tas bort.

### Vad tas bort

**MicPanel.tsx:**
- `getRotationInterval()` funktion (rad 119-123)
- Refs: `paletteIndexRef`, `targetColorRef`, `blendedColorRef`, `nextRotationAtRef` (rad 208-213)
- Palette sync-effect (rad 253-270) — ersätts med enkel colorRef-uppdatering
- rAF-blocket: palettrotation (rad 324-338) och crossfade (rad 341-354) — `colorRef` används direkt utan blending
- Props: `palette` tas bort från interfacet
- `onLiveStatus.paletteIndex` — alltid 0 eller tas bort

**Index.tsx:**
- `palette` state och `livePaletteIndex` state
- `setPalette`-anrop i extractPalette-then
- `palette`-prop till MicPanel

**lightCalibration.ts:**
- `crossfadeSpeed` från calibration-interfacet (kan behållas men ignoreras, enklare att ta bort)

**CalibrationOverlay.tsx:**
- "Färgövergång" (crossfadeSpeed) slider i Palett-gruppen

**DebugOverlay.tsx:**
- Palette-swatch-rendering och paletteIndex-highlight

**debugStore.ts:**
- `palette` och `paletteIndex` fält

**colorExtract.ts:**
- `extractPalette` returnerar fortfarande en array, men vi anropar den med `count: 1` och tar bara `colors[0]`

### Vad behålls
- `extractPalette` funktionen (anropas med count=1)
- `currentColor` state i Index.tsx — sätts en gång per låt
- `colorModStrength` (frekvensbaserad färgmodulering) — det är inte palette-relaterat
- `saturationBoost` i kalibrering — det gäller den aktiva färgen

### Risk
Låg. All palettrotation och crossfade är isolerad. Grundfunktionen (en färg → BLE) förblir identisk.

