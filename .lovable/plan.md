

## Plan: Professionell kick-filtrering med smoothing och false-positive-borttagning

### Problem
Nuvarande kick-detektering markerar *alla* samples över 70% av globalPeak som kicks. Det ger för många markeringar, inklusive falska positiva från brus eller mikrofon-artefakter.

### Lösning — tre steg i post-processing (MicPanel.tsx, rad 216-227)

**1. Minimum-avstånd mellan kicks (debounce)**
Kräv minst ~100ms mellan kicks. Om två kicks ligger närmare, behåll bara den starkaste. Detta tar bort "stutter"-markeringar.

**2. Lokal energi-kontrast**
En kick ska sticka ut mot sin omgivning. Jämför varje kandidats rawRms mot medelvärdet i ett fönster ±5 samples. Kräv att kicken är minst 1.3× starkare än lokalt medelvärde — filtrerar bort platåer där allt ligger högt.

**3. Beat-grid-snapping (om beatGrid finns)**
Om en kick inte ligger nära ett beat (±50ms), nedprioritera den. Riktiga kicks landar på beats.

### Implementation

Ändra **`src/components/MicPanel.tsx`** rad 216-227:

```text
Nuvarande flöde:
  threshold → markera alla över 70%

Nytt flöde:
  1. threshold 70% → kandidat-lista
  2. lokal kontrast-filter (1.3× lokal snitt ±5 samples)
  3. debounce: minst 100ms avstånd, behåll starkaste
  4. (valfritt) beat-snap bonus om beatGrid finns
```

Extrahera logiken till en ny funktion `refineKicks(samples: EnergySample[], beatGrid?: BeatGrid)` i **`src/lib/dropDetect.ts`** (eller en ny `kickRefine.ts`) för att hålla MicPanel ren.

### Filändringar
- **`src/lib/dropDetect.ts`** — ny exporterad funktion `refineKicks()`
- **`src/components/MicPanel.tsx`** — anropa `refineKicks()` istället för enkel threshold-loop

