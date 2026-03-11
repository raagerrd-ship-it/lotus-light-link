

## Analys: Kan vi slå upp exakta bas-slag för en låt?

### Problemet
Just nu detekterar vi beats i realtid via mikrofonen, vilket alltid har en fördröjning (ljud → mikrofon → FFT → BLE → LED). Frågan är om vi kan slå upp exakta beat-timestamps för en känd låt och synka mot dem.

### Verklighet och begränsningar

**Det finns inget publikt API som ger beat-timestamps gratis:**
- **Spotify Audio Analysis API** gav exakta beat/segment-timestamps, men stängdes ned i november 2024.
- **ACRCloud, Musixmatch, etc.** ger BPM men inte individuella beat-positioner.
- Att analysera hela ljudfilen kräver tillgång till ljudströmmen — vi har bara metadata från Sonos, inte raw audio.

**Grundproblemet:** Även om vi visste exakt var varje beat är i låten, måste vi veta exakt var i låten vi befinner oss (position). Vi har `position_ms` från Sonos, men den uppdateras med fördröjning (polling/realtime) och är inte exakt nog för <50ms precision.

### Vad vi kan göra (och redan gör)

Det nuvarande systemet är faktiskt nära optimalt:
1. **BPM från AI-lookup** → ger oss takten
2. **Lokal onset-detection via mikrofon** → ger oss fas-lås (exakt var i beat-cykeln vi är)
3. **Prediktiv firing 50ms före nästa beräknade beat** → kompenserar BLE-latens

### Förbättringsförslag: Bättre beat-grid via Sonos position

Vi kan förbättra synken genom att använda `position_ms` från Sonos som en extra fas-referens:

1. **Vid låtstart**: Hämta `position_ms` + BPM → beräkna beat-grid (`beatTime = position_ms % (60000/bpm)`)
2. **Fas-korrigering**: Justera `beatPhase` baserat på Sonos-position, inte bara mikrofon-onsets
3. **Mikrofonen bekräftar**: Onsets från mikrofonen finjusterar fasen men Sonos-positionen ger grunden

Detta ger oss en mer stabil beat-grid utan att vara helt beroende av mikrofon-timing.

### Plan

1. **Uppdatera `useSonosNowPlaying`** — exponera `positionMs` + `updatedAt` timestamp så vi kan beräkna aktuell position
2. **Skicka position till MicPanel** — ny prop `sonosPosition: { positionMs, receivedAt }`
3. **Fas-synk i MicPanel** — vid varje positions-uppdatering, beräkna förväntad beat-fas från `(estimatedCurrentPos % beatIntervalMs) / beatIntervalMs` och blanda med mikrofon-detekterad fas
4. **Mikrofonen förblir master** för snabba justeringar — Sonos-positionen korrigerar drift

