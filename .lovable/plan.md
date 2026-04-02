

## Visa Sonos playback state i debug-overlayen

### Vad

Lägg till `sonosPlaybackState` (den råa strängen från Sonos-proxyn, t.ex. `PLAYBACK_STATE_PLAYING`, `PLAYBACK_STATE_PAUSED_PLAYBACK`, `PLAYBACK_STATE_IDLE`) i debug-panelen under input-sektionen, med färgkodning.

### Ändringar

**1. `src/lib/ui/debugStore.ts`**
- Lägg till `sonosPlaybackState: string | null` i interface och default `null`

**2. `src/pages/Index.tsx`**
- Skriv `nowPlaying.playbackState` till `debugData.sonosPlaybackState` vid varje uppdatering (i samma callback/effect som redan sätter `debugData.isPlayingState`)

**3. `src/components/DebugOverlay.tsx`**
- Ny ref `playbackRef`
- I tick-loopen: visa kort label baserat på `sonosPlaybackState`:
  - `PLAYING` → grön `▶ playing`
  - `PAUSED` → gul `⏸ paused`  
  - `IDLE` → röd `⏹ idle`
  - Annat/null → grå `— no state`
- Rendera `<div ref={playbackRef} />` efter sonos-raden i input-sektionen

