# Record & Replay — lärda ljus-sekvenser per låt

## Idén, kort
Lotus spelar redan ut en ljus-reaktion (brightness + färg) per tick. Vi **spelar in den reaktionen** kopplad till låten som spelas. Nästa gång samma låt upptäcks → **spela upp den exakta sekvensen synkat mot låtens position** istället för att reagera live.

Ingen online-app krävs för kärnfunktionen — allt sker lokalt på Pi:n. Cloud-analys blir ett valfritt steg 2.

## Är det bra/dåligt + Pi-belastning
- **Inspelning:** nästan gratis. Vi buffrar bara värden enginen redan räknat ut. Ingen extra FFT, ingen rå-ljud-upload (som hade slagit mot WiFi-coex-flaskhalsen).
- **Lagring:** ~25 Hz × 4 min × ~5 byte/ram ≈ **30 KB per låt** (delta-kodat ännu mindre). 1000 låtar ≈ någon MB. Inget problem på SD-kortet.
- **Uppspelning:** *billigare* än live — ingen reaktiv FFT-loop behövs, vi slår bara upp rätt frame mot positionMs. Netto avlastning för Pi Zero 2W.

Slutsats: bra idé, låg risk, ryms lätt.

## Hur det hängs ihop

```text
  [Record-läge PÅ + MOTOR_ON]
  engine tick → onFrame(pct, rgb) ──► lightRecorder buffrar
        låt slutar / byts ──► spara light-seq/<songkey>.json

  [Auto-playback PÅ]
  Sonos trackName/artist ─┐
  (fallback) ACRCloud ────┴─► songkey ─► finns sekvens?
        ja → engine PLAYBACK-mode: frame@positionMs → sendToBLE
        nej → vanlig live-reaktion
```

## Steg 1 — Lokal record & replay (ingen online-app)

**1. Frame-tap i enginen** (`pi/src/piEngine.ts`)
- Lägg till en lättviktig callback `setFrameTap(cb)` som anropas i samma punkt där `sendToBLE(...)` redan körs, med `(pct, r, g, b)`. Ingen extra beräkning.

**2. Inspelare** (ny `pi/src/lightRecorder.ts`)
- Prenumererar på frame-tap. Aktiv endast när record-läge är på **och** lifecycle = MOTOR_ON.
- Buffrar `[tOffsetMs, pct, r, g, b]` nedsamplat till ~25 Hz (inte fulla ~93 Hz FFT-takten).
- `tOffsetMs` ankras mot Sonos `positionMs` så sekvensen är positionsbaserad, inte väggklocka.
- Vid låtbyte/PAUSED: spara `light-seq/<songkey>.json` i `DATA_DIR` (delta-kodad, kompakt).

**3. Song-key + igenkänning** (ny `pi/src/songIdentity.ts`)
- Primärt: normaliserad `artist|track` från sonosPoller → stabil nyckel.
- Fallback: ACRCloud-fingerprint (befintliga secrets) när trackName saknas (TV/extern källa). Endast vid behov, inte varje tick.

**4. Playback-mode i enginen**
- Nytt internt läge: när en känd sekvens finns och auto-playback är på, hoppar `tickInner` över den reaktiva pathen och anropar istället `playbackFrameAt(positionMs)`.
- Position interpoleras lokalt mellan Sonos-pollar (monoton klocka ankrad vid senaste `positionMs`) — samma princip som befintlig "track pos delta inference".
- Lifecycle-, BLE-keep-alive- och idle-pathar lämnas orörda.

**5. UI + endpoints**
- `configServer.ts`: `GET/PUT /api/record { recording }`, `GET/PUT /api/playback { autoPlay }`, `GET /api/light-seq/list`, `DELETE /api/light-seq/:key`.
- `PiMobile.tsx`: två toggles ("Spela in ljus-sekvenser", "Auto-spela kända låtar") + liten lista över sparade sekvenser med radera-knapp.

## Steg 2 — Valfri Cloud-sync / "analysera bättre"
Bara om du vill ha det — kärnan funkar utan.
- Ny tabell `light_sequences` (user_id, song_key, frames jsonb) med RLS, följer befintligt offline-first sync-mönster mot `user_settings`.
- Sekvenser kan synkas upp för backup/cross-device.
- Edge function som med Lovable AI kan släta/förstärka en inspelad sekvens off-Pi och skicka tillbaka en "förbättrad" version. Detta är den enda biten som motsvarar "online-app analyserar bättre".

## Verifiering
- Record på, spela en låt helt → `light-seq/<key>.json` skapas, rimlig storlek (<100 KB).
- Spela samma låt igen med auto-playback på → lampan följer sparad sekvens, synkad mot positionMs (driv < ~150 ms mellan pollar).
- Record av + playback av → exakt dagens beteende, inga regressioner.
- Pi-CPU under playback ≤ live-läget.
- `npx tsc --noEmit` rent.

## Avgränsning (medvetet uteslutet nu)
- Ingen rå-ljud-inspelning/upload (Pi-/WiFi-kostnad).
- Ingen automatisk "förbättring" på Pi:n — det hör hemma i valfria steg 2.
- Steg 2 byggs först om du säger till; steg 1 är fristående och levererar hela kärnvärdet.
