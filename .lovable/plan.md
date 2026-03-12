

# Uppdatera useSonosNowPlaying för bridge-integrerad proxy

Nu när Cast Away Web bridge har Sonos UPnP-endpointen med album art proxy och nästa låt-metadata behöver vi uppdatera `useSonosNowPlaying.ts` för att utnyttja den utökade datan.

## Ändringar i `src/hooks/useSonosNowPlaying.ts`

### 1. Använd `albumArtUri` från lokala proxyn
Bridge returnerar nu `albumArtUri` (t.ex. `/api/sonos/art?url=...`). Vid track change, bygg full URL från proxy-basen och sätt `albumArtUrl` direkt istället för `null`. Detta eliminerar 800-2000ms väntan på DB-fetch för albumomslag.

### 2. Använd `nextTrackName`/`nextArtistName` från lokala proxyn
Bridge returnerar nu nästa låt-info direkt. Sätt dessa istället för `null`.

### 3. Ta bort onödig DB-fetch och cloud-fetch vid lokal track change
När lokala proxyn har all data (art + next track) behövs inte:
- `tryFetchDb(0)` retry-loopen (bara som fallback om `albumArtUri` saknas)
- `fetchCloud()` anropet (bara om `nextTrackName` saknas)

### 4. Minska cloud metadata polling
Ändra 5s `cloudMetaTimer` till att bara köras om lokala proxyn saknar next track-info.

### Konkreta kodändringar

**Track change i `fetchLocal`** (rad 121-145):
- Bygg `albumArtUrl` från `s.albumArtUri` om den finns: `${proxyUrl}${s.albumArtUri}` (relativ URL) eller använd den direkt om absolut
- Sätt `nextTrackName: s.nextTrackName ?? null` och `nextArtistName: s.nextArtistName ?? null`
- Villkora DB/cloud-fetch: bara om `albumArtUri` saknas resp. `nextTrackName` saknas

**Same track update** (rad ~148-156):
- Uppdatera `nextTrackName`/`nextArtistName` från lokala svaret om de finns

Inga nya beroenden. Inga andra filer behöver ändras.

