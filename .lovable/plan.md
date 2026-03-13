

## Plan: Inlärd energikurva per låt — mikrofonfritt ljus vid omspelning

### Koncept

Första gången en låt spelas: mikrofonen fångar RMS som vanligt, och energikurvan sparas i `song_analysis`-tabellen (som redan finns). Nästa gång samma låt spelas: systemet hittar den sparade kurvan, synkar med Sonos-positionen via SSE-bridgen, och styr lampan direkt från kurvan — helt utan mikrofon.

### Arkitektur

```text
┌─────────────────────────────────────────────────┐
│  SSE bridge → useSonosNowPlaying                │
│    trackName + artistName + positionMs           │
└──────────────┬──────────────────────────────────┘
               │
     ┌─────────▼─────────┐
     │  song_analysis DB  │
     │  (energy_curve)    │
     │  track+artist key  │
     └─────────┬─────────┘
               │
  ┌────────────▼────────────┐
  │ MicPanel tick loop       │
  │                          │
  │ HAS curve? → interpolate │
  │   energy at positionMs   │
  │   → brightness + BLE     │
  │                          │
  │ NO curve? → mic RMS      │
  │   → record samples       │
  │   → save curve on end    │
  └──────────────────────────┘
```

### Steg

1. **Ny hook: `useSongEnergyCurve`**
   - Input: `trackName`, `artistName` (från `useSonosNowPlaying`)
   - Vid låtbyte: frågar `song_analysis` efter befintlig `energy_curve`
   - Returnerar `{ curve: EnergySample[] | null, loading: boolean }`
   - Cachar i minnet så samma låt inte frågas flera gånger

2. **Spela in energikurva under mic-läge**
   - I MicPanels tick-loop, om ingen sparad kurva finns: samla `{ t: positionSec, e: normalizedRms }` var ~100ms
   - Behöver `getPosition()` från Sonos-hooken för att mappa tid
   - Vid låtbyte eller unmount: spara kurvan till `song_analysis.energy_curve` (upsert på track+artist)

3. **Kurvstyrt läge i MicPanel**
   - Om sparad kurva finns: hoppa över mic-RMS, interpolera energi från kurvan vid aktuell `positionMs`
   - Använd samma AGC, smoothing, white-kick och BLE-logik som idag — enda skillnaden är att `rms` kommer från kurvan istället för mikrofonen
   - Mikrofonen hålls igång i bakgrunden för att uppdatera/förbättra kurvan över tid (running average)

4. **Props-ändringar**
   - `MicPanel` får nya props: `getPosition` (redan tillgänglig i Index) och `trackKey: { trackName, artistName } | null`
   - `Index.tsx` skickar dessa från `useSonosNowPlaying`

5. **Kurvförbättring (merge)**
   - Vid omspelning med mic aktiv: blenda ny mic-data med sparad kurva (exponentiellt glidande medelvärde) och spara uppdaterad version
   - Kurvan blir bättre för varje lyssning

### Dataformat i `song_analysis.energy_curve`

```json
[
  { "t": 0.0, "e": 0.12 },
  { "t": 0.1, "e": 0.35 },
  { "t": 0.2, "e": 0.58 }
]
```

Samplingsintervall ~100ms ger ~6000 samples för en 10-minuterslåt (~50KB JSON) — väl inom JSONB-gränser.

### Tekniska detaljer

- Lookup sker via `track_name` + `artist_name` (exakt match) i `song_analysis`
- Upsert: `ON CONFLICT` behövs inte — vi gör `select` först, sedan `insert` eller `update`
- `interpolateEnergy` finns redan i `autoCalibrate.ts` — återanvänds
- Ingen ny tabell behövs — `song_analysis` har redan `energy_curve` JSONB-kolumn

