

# Implementera Build-ups, Dynamic Range, Transitions & Beat Strength

## Översikt
Fyra nya post-recording analyser som körs automatiskt efter inspelning och sparas i `song_analysis`. Ljusstyrningen konsumerar dessa för en mer professionell upplevelse.

## 1. Databasändring
Lägg till tre JSONB-kolumner i `song_analysis`:
- `dynamic_range` — percentiler (P10, P50, P90) + peak
- `transitions` — array med tidpunkt, typ (hard/fade), från/till-sektion
- `beat_strengths` — array med per-beat intensitetsvärde (downbeat vs upbeat)

Build-ups behöver ingen ny kolumn — de detekteras redan via `drops[].buildStart` och kan förbättras med ramp-regression direkt i `dropDetect.ts`.

## 2. Nya analysfunktioner

### `src/lib/songAnalysis.ts` (ny fil)
```text
analyzeDynamicRange(curve) → { p10, p50, p90, peak }
  - Sorterar rawRms-värden, plockar percentiler

analyzeTransitions(sections, curve) → Transition[]
  - Jämför energi i sista 0.5s av sektion A vs första 0.5s av sektion B
  - Stor skillnad = "hard", liten = "fade"
  - Sparar crossfade-hastighet (ms)

analyzeBeatStrengths(curve, beatGrid) → number[]
  - För varje beat i gridet: hämta rawRms vid beat-tidpunkt
  - Normalisera mot P90
  - Markera beats i 4/4-takt (1:an starkast)
```

### `src/lib/dropDetect.ts` (uppdatering)
Förbättra build-up-detektering med linjär regression:
- Beräkna R² och lutning över glidande 3-8s fönster
- Lägg till `rampSlope` och `rampR2` på `Drop`-interfacet
- Används av ljusstyrningen för att gradvis öka puls/intensitet

## 3. Integration i `useSongEnergyCurve`
- Lägg till state för `dynamicRange`, `transitions`, `beatStrengths`
- Kör analyserna i `saveCurve` efter inspelning (samma pass som BPM/drops)
- Spara till DB och cacha
- Ladda från DB vid kurv-hämtning
- Exponera via hook-resultatet

## 4. Ljusstyrning (`sectionLighting.ts`)
- `getSectionLighting` tar emot `dynamicRange` och normaliserar `brightnessScale` baserat på percentiler istället för fasta värden
- Ny funktion `getTransitionParams(transitions, timeSec)` → crossfade-hastighet och typ
- `beatPulse` förstärks med `beatStrengths[i]` — downbeats (beat 0 mod 4) pulserar starkare
- Build-up ramp: `getBuildUpIntensity` använder `rampSlope` för mjukare exponentiell upptrappning

## 5. Konsumtion i MicPanel/Index
MicPanel använder redan `getSectionLighting` och `beatPulse` — de nya parametrarna flödar automatiskt genom befintliga funktioner. Minimal ändring behövs:
- Skicka `dynamicRange` till ljusberäkningen för korrekt normalisering
- Skicka `beatStrengths` + aktuellt beat-index till `beatPulse`
- Använd `transitions` för att styra crossfade vid sektionsbyte

## Filändringar sammanfattning
| Fil | Ändring |
|-----|---------|
| DB migration | +3 kolumner på `song_analysis` |
| `src/lib/songAnalysis.ts` | Ny: dynamicRange, transitions, beatStrengths |
| `src/lib/dropDetect.ts` | Lägg till rampSlope/rampR2 på Drop |
| `src/lib/sectionLighting.ts` | Konsumera dynamicRange, transitions, beatStrengths |
| `src/hooks/useSongEnergyCurve.ts` | State + analys + DB load/save för nya fält |
| `src/components/MicPanel.tsx` | Skicka nya params till ljusberäkning |

