

## Prefetch av nästa låts albumomslag

### Idé
Sonos-proxyn ger redan `nextTrackName` och `nextArtistName`. Vi kan använda dessa för att **förladda nästa låts albumomslag och extrahera färgpaletten i förväg**, så att vid låtbyte sätts färgen omedelbart utan att vänta på bildladdning + extraktion (~200–500ms).

### Åtgärd

**1. `src/lib/ui/colorExtract.ts` — ny export `prefetchPalette`**
- Lägg till en enkel in-memory cache (`Map<string, RGB[]>`) som lagrar extraherade paletter per bild-URL.
- `prefetchPalette(url)` — kör `extractPalette` och sparar resultatet i cachen. Returnerar void (fire-and-forget).
- `getCachedPalette(url)` — returnerar cachad palett eller `null`.
- Begränsa cachens storlek till ~20 entries (LRU-style: radera äldsta vid overflow).

**2. `src/hooks/useSonosNowPlaying.ts` — resolve nästa låts art-URL**
- Proxyn ger redan `nextTrackName`/`nextArtistName`. Utöka med att hämta `nextAlbumArtUrl` från proxyn (om den exponeras) eller bygg URL via iTunes edge function baserat på next-track metadata.
- Exponera `nextAlbumArtUrl` i `SonosNowPlaying`-interfacet.

**3. `src/pages/Index.tsx` — prefetch + instant apply**
- Ny `useEffect` som triggar på `nowPlaying?.nextAlbumArtUrl`: kör `prefetchPalette(url)`.
- I det befintliga palette-effectet (rad 104–114): kolla `getCachedPalette(artUrl)` först — om cache hit, sätt färgen direkt utan async. Annars kör `extractPalette` som fallback.

### Flöde
```text
Låt A spelar → nextTrackName finns
  → resolve art-URL för nästa låt
  → prefetchPalette() laddar bild + extraherar färg i bakgrunden
  → palett sparas i cache

Låtbyte till Låt B
  → getCachedPalette(B:s art-URL) → instant hit
  → färg sätts direkt, 0ms fördröjning
```

### Begränsningar
- Om proxyn inte exponerar `nextAlbumArtUrl` direkt behöver vi använda iTunes-lookup (edge function) med nextTrackName/nextArtistName för att hitta art-URL. Det kostar ett extra API-anrop men sker i bakgrunden medan nuvarande låt fortfarande spelar.

