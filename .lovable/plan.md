

# Offline föranalys av låtar

## Problemet
Systemet förlitar sig helt på realtids-mikrofonanalys för beat-detektering. Det ger ingen information om låtens struktur (intro, vers, refräng, drop) och BPM:en hämtas via AI som bara ger ett enda tal. Ingen möjlighet att veta vad som kommer härnäst i låten.

## Begränsningar
Spotify Audio Analysis API (som gav exakta beat-maps) är **nedlagd sedan 2024**. Vi har inte direkt tillgång till ljudfilen eftersom musiken streamas via Sonos. Det utesluter klientbaserad offline-analys (Essentia.js etc.).

## Lösning: AI-driven sektionsanalys + cache

### 1. Ny edge function: `song-analysis`
Anropas vid låtbyte. Frågar AI-modellen (gemini-2.5-flash) efter detaljerad låtstruktur:

```text
Input:  { track: "Blinding Lights", artist: "The Weeknd" }
Output: {
  bpm: 171,
  sections: [
    { type: "intro",   startSec: 0,   endSec: 11,  energy: 0.6 },
    { type: "verse",   startSec: 11,  endSec: 42,  energy: 0.5 },
    { type: "chorus",  startSec: 42,  endSec: 73,  energy: 0.9 },
    { type: "verse",   startSec: 73,  endSec: 104, energy: 0.5 },
    { type: "chorus",  startSec: 104, endSec: 135, energy: 0.95 },
    { type: "bridge",  startSec: 135, endSec: 158, energy: 0.7 },
    { type: "chorus",  startSec: 158, endSec: 196, energy: 1.0 },
    { type: "outro",   startSec: 196, endSec: 210, energy: 0.4 }
  ],
  drops: [42, 104, 158],
  key: "Fm"
}
```

Ersätter nuvarande `bpm-lookup` (som bara ger BPM). Cacheas i en ny `song_analysis`-tabell.

### 2. Databastabell: `song_analysis`
```sql
CREATE TABLE song_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_name text NOT NULL,
  artist_name text NOT NULL,
  bpm integer,
  sections jsonb,
  drops jsonb,
  key text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(track_name, artist_name)
);
ALTER TABLE song_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON song_analysis FOR SELECT USING (true);
```

### 3. Klient: använda sektionsdata i MicPanel
- **Index.tsx**: Vid låtbyte, anropa `song-analysis` istället för `bpm-lookup`. Spara `sections` + `drops` i state och skicka ner till `MicPanel`.
- **MicPanel.tsx**: Ny prop `songSections`. Baserat på `sonosPosition` (som redan finns), räkna ut vilken sektion vi är i:
  - **Intro/outro**: Dämpad puls, lägre max-brightness
  - **Vers**: Mjuk breathing-effekt, färgen dominerar
  - **Refräng**: Full beat-reaktivitet, punch-white aktiv
  - **Drop**: Flash-sekvens, maximal brightness
- Vid `drops`-tidpunkter: trigga en stark puls oavsett mikrofoninput (prediktivt, vi vet exakt när droppet kommer)

### 4. Prediktiva drops
Eftersom vi vet drop-tidpunkterna och har `sonosPosition`:
```text
estimatedMs = sonosPosition.positionMs + (now - sonosPosition.receivedAt)
currentSec  = estimatedMs / 1000

// 50ms innan drop → pre-fire full brightness
nextDrop = drops.find(d => d - currentSec > 0 && d - currentSec < 0.1)
if (nextDrop) → ble.brightness(100) + flash
```

## Filer som ändras
1. **Ny**: `supabase/functions/song-analysis/index.ts` — AI-driven sektionsanalys
2. **Ny tabell**: `song_analysis` via migration
3. **Ändra**: `src/pages/Index.tsx` — byt `bpm-lookup` mot `song-analysis`, skicka sections till MicPanel
4. **Ändra**: `src/components/MicPanel.tsx` — ny prop `songSections`, sektionsmedveten brightness/effekt, prediktiva drops
5. **Ta bort**: `supabase/functions/bpm-lookup/` (ersätts av `song-analysis`)

