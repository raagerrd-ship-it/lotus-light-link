

## Automatisk färgrotation med lång crossfade

Eftersom sektionsbyten inte längre triggar färgbyte behöver vi en timer-baserad rotation genom paletten med mjuk övergång.

### Upplägg

**I `MicPanel.tsx`:**
- Lägg till en `useEffect` som startar ett intervall (t.ex. var **20:e sekund**) som stegar `paletteIndex` framåt
- Håll en `targetColorRef` och `blendedColorRef` — varje tick i animationsloopen interpolerar `blendedColorRef` mot `targetColorRef` med en långsam alpha (~0.005-0.01 per frame → ca 3-5s fade)
- Använd `blendedColorRef` istället för `colorRef` överallt i tick-loopen (BLE-skrivning, glow, canvas)
- Callback `onColorChange` till `Index.tsx` så att UI:t (glow, NowPlayingBar) också uppdateras

**I `Index.tsx`:**
- Ta emot `onColorChange` från MicPanel och uppdatera `currentColor` state
- Behåll `paletteIndexRef` och uppdatera den via callback

### Detaljer
- Rotation pausas om `palette.length <= 1`
- Vid nytt album-art (ny palette) resettas index till 0 och blendedColor snäpper till första färgen
- Crossfade sker per-frame i `requestAnimationFrame`-loopen som redan finns — ingen extra timer behövs för själva blendningen
- Rotationsintervallet kan kopplas till BPM senare om önskat (t.ex. var 8:e takt)

### Filer
- `src/components/MicPanel.tsx` — rotationstimer + crossfade-logik i tick-loop
- `src/pages/Index.tsx` — onColorChange callback, uppdatera paletteIndex

