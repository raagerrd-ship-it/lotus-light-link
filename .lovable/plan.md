

## Sonos-integration: Hämta låtinfo och albumfärg

### Idé
Koppla ihop detta projekt med [brew-monitor-tv](/projects/fc7fbdf7-4480-491f-816e-37d0f6c3b251) genom att läsa `sonos_now_playing`-tabellen direkt (den har publik SELECT-policy). Från albumomslaget extraherar vi dominant färg och sätter den som LED-färg automatiskt. BPM kan vi slå upp via ett externt API baserat på låttitel + artist.

### Arkitektur

```text
brew-monitor-tv Supabase
  └─ sonos_now_playing (public SELECT)
        │
        ▼  (poll varje 5s eller realtime)
  BLE-appen (detta projekt)
        │
        ├─ Album art URL → Canvas color extraction → sendColor()
        └─ Track + Artist → BPM lookup (edge function) → framesPerBeat
```

### Ändringar

#### 1. Skapa en Sonos-hook (`src/hooks/useSonosNowPlaying.ts`)
- Skapar en **andra** Supabase-klient som pekar mot brew-monitor-tv:s projekt (URL + anon key hårdkodas — tabellen är publikt läsbar)
- Prenumererar på realtime-ändringar på `sonos_now_playing`, alternativt pollar var 5:e sekund
- Returnerar `{ trackName, artistName, albumArtUrl, playbackState }`

#### 2. Färgextraktion från albumomslag (`src/lib/colorExtract.ts`)
- Laddar albumbilden i en offscreen `<canvas>`
- Samplar pixlar och beräknar dominant färg (enkel k-means eller frequency-bucket)
- Filtrerar bort för mörka/ljusa färger (behöver vibrant färg för LED)
- Returnerar `[r, g, b]`

#### 3. Integrera i `Index.tsx`
- Kalla `useSonosNowPlaying()` 
- När `albumArtUrl` ändras → extrahera färg → uppdatera `currentColor` och skicka till LED
- Visa låttitel + artist i ett litet UI-element (som brew-monitor-tv:s widget, men minimalt)

#### 4. BPM-lookup via edge function (valfritt, steg 2)
- Skapa en edge function som tar `track + artist` och slår upp BPM via ett gratis musik-API (t.ex. Spotify Web API eller fritt alternativ)
- Skickar tillbaka BPM → sätter `bpmRef.current` direkt istället för att förlita sig enbart på onset-detektion
- Kan blandas med lokal detektion: om API ger BPM, använd det; annars fallback till mikrofon

### Fråga att ta ställning till

Brew-monitor-tv:s Supabase-URL och anon key behövs i koden. Eftersom tabellen har publik SELECT-policy är anon key inte känslig — den kan ligga i koden. Alternativt kan vi skapa en edge function i *detta* projekt som proxar anropet.

### Vad vi INTE gör
- Kopierar inte Sonos OAuth-flödet — brew-monitor-tv sköter all synk
- Ändrar inget i brew-monitor-tv

