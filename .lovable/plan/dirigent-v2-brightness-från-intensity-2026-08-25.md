# Dirigent v2: brightness från intensity

## Mål

Få lampans brightness att följa analysatorns `frame.intensity` i stället för den platta VU/amplitudvägen, medan rå amplitud bara används som långsam loudness-skala för tyst/låg volym.

Successkriterium: vid uppbyggnad ska brightness stiga och ligga kvar när `intensity` ligger högt; vid breakdown ska brightness sjunka. Mätningen ska kunna visa klart högre korrelation mellan brightness och `intensity` än v754.

## Bekräftat nuläge

- `pi/src/alsaMic.ts` sätter i dag `latestBands.shape = frame.levelVU`.
- `pi/src/piEngine.ts` använder `bands.shape` som snabb form och `bands.totalRms` via `ampEnv` som tak: `outN = floorN + shapeSm * (ceiling - floorN)`.
- `Frame` innehåller redan `intensity` som sektionsenergi (`0.5 = låtens snitt`, lägre vid breakdown, högre vid topp/drop).

## Ändringar

1. **Byt formkälla i mic-adaptern**
   - I `emitBands(frame)` sätts `latestBands.shape` från `frame.intensity` i stället för `frame.levelVU`.
   - Klampa till `0..1`.
   - Behåll bandandelar, `totalRms`, flux, bassFlux och tapp-isoleringen oförändrade.

2. **Gör rå amplitud till loudness-skala, inte dynamikbärare**
   - I `tickInner()` byts tak-formeln från “ampEnv sätter aktivt tak” till en långsam `loudness`-faktor.
   - Föreslagen minimal form:
     ```text
     energyForm = smoothed(frame.intensity) + onsetBoost
     loudnessRaw = slow envelope(level)
     loudness = clamp(0.65 + loudnessRaw * ceilingSensitivity * 0.35, 0, 1)
     brightness = floorN + energyForm * (1 - floorN) * loudness
     ```
   - Det gör att amplitude fortfarande dimmar tyst/låg volym, men inte kväver dynamiken när nivån bara rör sig 9–21% inom låten.

3. **Behåll punch och drops**
   - `onsetBoost` fortsätter ge snabb beat-punch additivt.
   - Drop-flash fortsätter forcera 100% brightness med aktuell palettfärg.
   - Beat-grid, track-change-hint, BLE/watchdog och övrig stabilitetslogik lämnas orörd.

4. **Uppdatera diagnostik och UI-simulering**
   - Diagnostikfält som i dag visar `ampEnv/shape/ceiling` uppdateras så de motsvarar Dirigent v2: `intensity/energyForm/loudness` där det behövs.
   - `LightPreview` justeras till samma formel så sliderförhandsvisningen matchar verklig output.

## Verifiering

- Kör typkontroll för Pi-koden.
- Kontrollera att `/api/status` fortfarande exponerar brightness, analyser-intensity och motorns form/loudness-signaler.
- Live-verifiering på Pi: spela en låt med tydlig uppbyggnad/breakdown och jämför `lastSent.pct` mot `analyser.intensity`; målet är att korrelationen går från ca 0.16 till >0.7.
