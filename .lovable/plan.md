# Använda analysatorns nya signaler i ljusomvandlingen

## Läget idag

Motorn kör två parallella ljudvägar:

- **Ljuset** styrs av den egna 2-bands-FFT:n (`getLatestBands()` → bassRms/midHiRms) plus egna detektorer i `piEngine.ts`: `processOnset` (bas-flux-median) och `processDrop` (bassFast/bassSlow-svacka).
- **Den nyporterade analysatorn** (`audio-analyser/`) levererar ett mycket rikare `Frame` — 8 oktavband med per-band-AGC och per-band-onsets, trumenvelopes (`drum.kick/snare/hat/bass`), `intensity` (sektionsenergi mot låtens eget snitt), `dropCount`/`inZone`/`breaking`/`buildUp`, `centroid`, `profile.*`, `barShift`.

Av allt detta använder ljusvägen idag **bara** `kickAtMs` (PLL-fas) och `bpm` (grid-puls). Resten går ut på `/api/status` som telemetri och kastas. Det är där vinsten finns.

## Föreslagen ordning (varje steg är fristående och kan trimmas live innan nästa)

### Steg 1 — Drop från analysatorn i stället för egen svacke-detektor
Ersätt triggern i `processDrop` med en flankjämförelse mot `frame.dropCount` (monoton, kan inte missas på 100 Hz). Behåll allt utgående beteende: refraktärtid, `dropFlashMs`, palettfärg, express-write. Egna bassFast/bassSlow-grindarna blir fallback när analysatorn inte har lås (`bpm === 0`), så det aldrig blir svart om taktlåset tappas. Vinst: analysatorns drop är novelty/kropp-baserad och trimmad mot riktigt material — den egna är en ren bas-svacka och missar drops utan bastapp.

### Steg 2 — Sektionsmedveten dynamik (`intensity`)
`dynamicCenter` spåras idag ur ren mic-energi. Låt `frame.intensity` skjuta centret: breakdown (<0.34) ger lägre center → mer expansion i det tysta; topp-zon (>0.78) ger högre center → mindre pumpande i tuttin. Ny cal-param `intensityInfluence` (0 = av, default lågt ~0.3) så det kan nollas live.

### Steg 3 — Transienter från trumenvelopes
`processOnset` matas idag med bas-flux från den egna FFT:n. Byt boost-källan till `frame.drum.kick` (och en liten andel `drum.snare`) när analysatorn har färska frames. Det separerar kick från basgång (analysatorns `spec.kick` är skild från `spec.bass`), vilket ger renare punch på spår där basgången maskerar kicken. Behåll `transientGain` som enda styrka-ratt.

### Steg 4 — Bandmix på oktavband i stället för 2 band
Låt `bassWeight` blanda `spec.sub+kick+bass` mot `spec.mid+highMid+treble` (per-band-AGC redan gjord i analysatorn) i stället för bassRms/midHiRms. Ger jämnare ljusbild mellan låtar med olika mix, eftersom varje band har egen AGC. Bakåtkompatibelt: `beatCutoffHz`-sliderns värde mappas till var i bandlistan snittet går.

### Steg 5 — Accent på ettan (`barShift`)
Grid-pulsen är lika stark på alla fyra slag. Med `barShift` vet motorn var ettan ligger: ge slag 1 en högre `onsetTarget` (t.ex. ×1.3) och slag 2–4 oförändrat. Endast när `barShift >= 0` och bpm-konfidensen är god.

## Teknisk detalj

- All ny läsning sker i `onFluxReady`/`tickInner` via befintlig `getLatestFrame()` — ingen ny FFT, ingen ny CPU-kostnad på Pi Zero 2W.
- Färskhetsguard som i PLL:en: analysatorsignaler används bara när en frame är nyare än ~60 ms, annars faller varje steg tillbaka på nuvarande beteende.
- Nya cal-fält (`intensityInfluence`, `dropSource`, `transientSource`, `bandMixMode`, `barAccent`) läggs i `LightCalibration` med defaults som ger dagens beteende, så inget ändras förrän du slår på det i UI/`/api/calibration`.
- `audio-analyser/` förblir read-only mirror — inga ändringar där, all logik i `piEngine.ts`/`alsaMic.ts`.
- Telemetri: `/api/status` får fälten som faktiskt styr ljuset (vald dropkälla, intensityInfluence-bidrag) så du kan se i ladan vad som gör vad.

## Frågan om ordning

Steg 1–3 är de med störst hörbar/synlig effekt. Steg 4 är den största omskrivningen av pipelinen och bör tas för sig. Steg 5 är kosmetiskt tills du har en takt-effekt att hänga på.
