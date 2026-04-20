
## Ta bort palettläge (färgrotation under låt)

Behåller: albumart-färgen sätts som lampans grundfärg vid varje låtbyte (palette[0] från Sonos Gateway).
Tar bort: hela mekanismen som cyklar/blandar mellan paletten under låtens gång (lägena Av/Tid/Bas/Energi/Blend).

### Ändringar

**`pi/src/piEngine.ts`**
- Ta bort typen `PaletteMode` och fälten `paletteMode`, `paletteRotationSpeed` från `LightCalibration` + `DEFAULT_CAL`.
- Ta bort `paletteTimedSpeed` från `TickConsts` + beräkningen i `computeTickConsts`.
- Ta bort state: `_paletteTickCounter`, `_bassWasHigh`, `_paletteIndex` (men behåll `_palette` och `setPalette`/`getPalette` så Sonos kan skicka in färgen).
- Ta bort hela "Palette mode"-blocket (rader ~666–703) i `tickInner`. Färgen styrs nu enbart av `setColor` (anropad vid låtbyte) + bas/disk-blendning som redan sker i color calibration.
- Ta bort `paletteIndex` från `TickData` + `_tickData` (eller behåll fältet tomt = 0 om det är jobbigt att ändra typen — föredrar att ta bort helt).
- Förenkla `setPalette`: spara bara paletten internt om någon vill läsa den; sätt `this.color = palette[0]` (albumart-grundfärg). Ingen index-reset behövs.

**`pi/src/configServer.ts`**
- `engine.palette` i `/api/status`: behåll (UI visar swatches), eller ta bort om inget UI längre behöver listan. Förslag: behåll — den visar fortfarande "låtens palett" som info.

**`pi/src/sonosPoller.ts`**
- Ingen ändring. Palette levereras fortsatt och `pi/src/index.ts` anropar `setColor(palette[0])` vid art-byte.

**`src/pages/PiMobile.tsx`**
- Ta bort `PaletteMode`-typen, `PALETTE_MODES`-arrayen och `paletteMode`-fältet från `Cal`-typen.
- Ta bort `paletteMode` ur alla `PRESET_CALS`-poster och ur `DEFAULT_CAL`.
- Ta bort hela "Palettläge"-sektionen i UI:t (raderna ~453–470 — `<div>Palettläge</div>` + chip-knapparna).
- Ta bort `paletteMode` ur `setCal`-payload som skickas till backend (raderna kring 1677 och 1747).
- Behåll `livePalette`-state och swatch-visningen (om sådan finns) — den visar fortfarande låtens färgpalett som info.

**Memory**
- Radera `mem://pi/sonos/palette-integration` (beskriver det borttagna läget).
- Uppdatera `mem://index.md`: ta bort raden "Palette integration".

### Verifiering
1. `npx tsc` i `pi/` och root → båda ska kompilera rent.
2. `grep -rn "paletteMode\|PaletteMode\|PALETTE_MODES" pi/src src` → ska returnera noll träffar.
3. Vid låtbyte ska lampans grundfärg fortfarande hoppa till albumartens dominanta färg (palette[0]). Färgen ska sedan stå still under låten (modulerad av bas/disk-vikt), inte rotera.

### Risker
Inga DB-ändringar. Settings-payloaden blir bakåtkompatibel: backend ignorerar okänt `paletteMode`-fält om gammal klient skickar det. Ingen migration krävs.
