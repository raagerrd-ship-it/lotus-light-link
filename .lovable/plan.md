

# Tre synkförbättringar

## 1. Snabbare watchdog-polling (2.5s → 1.5s)
Enkel ändring i `useSonosNowPlaying.ts` — byt `setInterval(fetchApi, 2500)` till `1500`.

## 2. Pre-fetch nästa låts analys
Sonos API:t returnerar `nextTrackName`/`nextArtistName`. Vi kan använda dessa för att anropa `song-analysis` i förväg så att cache-tabellen redan har data vid låtbyte.

**`useSonosNowPlaying.ts`**: Exponera `nextTrackName` och `nextArtistName` från API-svaret.

**`Index.tsx`**: Ny `useEffect` som triggar en fire-and-forget fetch till `song-analysis` när `nextTrackName` ändras (utan att uppdatera state — det sker vid faktiskt låtbyte).

## 3. Mic-baserad auto-kalibrering av syncOffset
Jämför mikrofonens detekterade beats mot BPM-gridens förväntade beat-tidpunkter. Om det finns en konsekvent offset (t.ex. beats kommer 80ms sent), justera `syncOffsetMs` automatiskt.

**`MicPanel.tsx`**:
- Vid varje onset, beräkna `expectedBeatMs` från Sonos-positionen + BPM-grid
- Mät `actualBeatMs` (onset-tidpunkt i låtposition)
- Samla `drift = actual - expected` i en buffer (senaste ~16 beats)
- Om medelvärdet av drift är stabilt (stddev < 30ms), rapportera drift till parent via ny callback `onSyncDriftMs`

**`Index.tsx`**:
- Ny callback `onSyncDriftMs` som tar emot drift-medelvärdet
- Applicera det som automatisk justering ovanpå manuell offset (additiv)
- Begränsa till ±200ms, exponentiellt utjämnad

## Filer som ändras
1. `src/hooks/useSonosNowPlaying.ts` — polling 1.5s, exponera nextTrack
2. `src/pages/Index.tsx` — pre-fetch nästa låt, auto-calibration callback
3. `src/components/MicPanel.tsx` — drift-mätning vid onsets, ny prop/callback

