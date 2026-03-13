

## Ytterligare förbättringar: BPM och sektionsanalys

### Vad vi redan har
- `bpmEstimate.ts` med autokorrelation (oanvänd just nu)
- Frekvensband (lo/mid/hi) i sparade kurvor
- BPM-kolumn i `song_analysis`-tabellen

### Vad som faktiskt ger mest

#### 1. BPM-estimering från inspelad kurva → beat-synkade kicks
Istället för att trigga white kick på absolut tröskel (pct > 95), kan vi använda BPM för att förutsäga *nästa* beat och synka kicken exakt. Det ger pumpande ljus som faktiskt följer takten.

- Kör `estimateBpmFromHistory` på sparad `energy_curve` vid laddning
- Spara BPM till `song_analysis.bpm` (kolumnen finns redan)
- Vid uppspelning: beräkna beat-fas från BPM + position, pulsera ljusstyrkan i takt
- Kick-triggers synkas till närmaste beat istället för att vara rent amplitud-baserade

#### 2. Sektionsdetektering (vers/refräng/drop) via AI
Skicka den sparade energikurvan (lo/mid/hi + e) till en edge function som använder Lovable AI för att klassificera sektioner. AI:n kan identifiera:
- **Intro/outro**: låg energi, fade
- **Vers**: medel-energi, jämn
- **Refräng**: hög energi, bred frekvens
- **Drop/build-up**: snabb energiökning
- **Break**: plötslig energiminskning

Resultatet sparas som `sections` i `song_analysis` (kolumnen finns redan):
```json
[
  { "start": 0, "end": 32.5, "type": "intro", "intensity": 0.3 },
  { "start": 32.5, "end": 95.0, "type": "verse", "intensity": 0.5 },
  { "start": 95.0, "end": 128.0, "type": "chorus", "intensity": 0.9 }
]
```

#### 3. Ljuseffekter baserat på sektioner
- **Intro/outro**: långsam fade, minimal kick
- **Vers**: mjuk pulsering i takt med BPM, dämpad färg
- **Refräng**: full intensitet, aggressivare kicks, bredare färgmodulering
- **Drop**: maximal kick-frekvens, stroboskopisk effekt
- **Build-up**: gradvis ökande intensitet och kick-frekvens

### Steg

1. **BPM från kurva**: Vid laddning av sparad kurva, kör `estimateBpmFromHistory` på `e`-värdena. Spara BPM till databasen. Använd i MicPanel för beat-synkad pulsering.

2. **AI-sektionsanalys**: Ny edge function `analyze-sections` som tar energikurvan och skickar till Lovable AI med prompt att klassificera sektioner. Körs en gång efter första inspelning. Sparar resultat i `song_analysis.sections`.

3. **Sektionsmedveten ljusstyrning i MicPanel**: Läs `sections` från databasen. Vid uppspelning, slå upp aktuell sektion baserat på position. Justera `minBrightness`, `maxBrightness`, kick-tröskel och färgmoduleringsstyrka per sektionstyp.

4. **Visa BPM och sektion i NowPlayingBar**: Visa aktuell BPM och sektionstyp (vers/refräng/drop) i gränssnittet.

### Tekniska detaljer

- `estimateBpmFromHistory` behöver anpassas för att ta `EnergySample[].map(s => s.e)` istället för rå history
- Edge function använder `LOVABLE_API_KEY` (redan konfigurerad) och `google/gemini-3-flash-preview`
- Sektionsanalysen körs asynkront efter att kurvan sparats — påverkar inte realtidsprestanda
- Beat-synk: `beatPhase = ((positionSec * bpm / 60) % 1)` ger 0-1 fas, används för sinusformad pulsering

