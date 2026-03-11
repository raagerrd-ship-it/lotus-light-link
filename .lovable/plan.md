

# MicPanel.tsx — Granskning

## Bedömning

Komponenten är redan väl optimerad för sitt syfte — en realtids-DSP-loop med BLE-dispatch som körs på 60fps. Koden är uppdelad i tydliga sub-funktioner (`sampleEnergy`, `detectBeatsAndBpm`, `computeBrightness`, `updateVisuals`, `dispatchBle`) och använder refs konsekvent för att undvika React-omrenderingar i den heta loopen.

## Möjliga förbättringar

### 1. Bryt ut canvas-ritningen (~90 rader)
`updateVisuals` innehåller ~90 rader canvas-chartritning (rad 503–595) som är ren renderingslogik utan koppling till BLE eller DSP. Kan extraheras till en separat funktion `drawIntensityChart(canvas, history, ...)` i en egen fil, t.ex. `src/lib/drawChart.ts`.

### 2. Bryt ut BPM-estimering (~40 rader)
`estimateBpmFromHistory` (rad 213–253) är en fristående auto-korrelationsfunktion som bara läser `energyHistoryRef`. Kan flyttas till `src/lib/bpmEstimate.ts`.

### 3. Eliminera redundant "lift"-beräkning
Samma `cr + (255 - cr) * lift`-mönster upprepas i `updateVisuals` (rad 469–472, 481–483) och `dispatchBle` (rad 611–616, 648–652). En liten `liftColor(color, factor)` helper skulle minska duplicering.

### 4. Pre-allokera canvas gradient
`createLinearGradient` anropas varje frame per segment (~300 anrop/frame). Kan inte helt elimineras pga varierande färger, men segmenten kan batchas med `Path2D` för att minska draw calls.

### 5. Minska refs-mängden
Flera refs (`colorThrottleRef`, `boostStartRef`, `boostColorRef`, `colorBoostedRef`) representerar ett enda "color boost"-tillstånd och kan samlas i ett enda ref-objekt:
```ts
const colorBoostRef = useRef({ active: false, startTime: 0, color: [255,255,255] });
```

## Vad jag INTE rekommenderar att ändra

- **DSP-loopen** — den är tight och performant, splittad i rätt granularitet
- **Ref-mönstret** för currentColor/char/punchWhite — nödvändigt för att undvika loop-omstarter
- **BLE-kön** — enkel och effektiv prioritetskö
- **Komponentuppdelning** — att bryta ut till child-komponenter ger ingen vinst här eftersom allt styrs via refs, inte React-state

## Sammanfattning

Komponenten är i grunden sund. De konkreta förbättringarna (1–3) minskar filen med ~140 rader och förbättrar läsbarheten utan att påverka prestanda. Punkt 4–5 är nice-to-have.

