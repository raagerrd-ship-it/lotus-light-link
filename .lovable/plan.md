# ACRCloud-igenkänning (valbart läge)

## Mål
Känna igen låtar som spelas utan Sonos-metadata (TV/SPDIF/extern källa) genom att spela in ~10 s mikrofon-ljud, skicka till ACRCloud och få artist + titel. Resultatet (a) visas i appen och (b) blir song-key för befintlig record/replay-funktion så inlärda ljus-shower kan återanvändas.

## Beslut (bekräftade)
- **Trigger:** Auto när `trackName` saknas (TV-läge/extern källa). En identifiering per ny okänd passage.
- **Capture-längd:** ~10 sekunder.
- **Efter träff:** Visa namnet i appen OCH koppla nyckeln till record/replay.
- Allt är **valbart** — av som default, slås på via toggle i appen.

## Viktig förutsättning
ACRCloud-credentials finns i Lovable-miljön, men **Pi:n är en separat enhet**. Pi-processen behöver `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` och `ACRCLOUD_HOST` i sin egen env (PCC/systemd-unit). Om de saknas på Pi:n loggar engine en tydlig varning och ACR-läget blir en no-op (returnerar null) — resten av systemet påverkas inte.

## Så fungerar det (flöde)
```text
Sonos poll: playing men trackName == null  (TV/SPDIF)
        │  och ACR-läge PÅ
        ▼
alsaMic samlar rå mono-PCM i en ringbuffer (~10s)
        ▼
acrIdentify(): bygg WAV (8kHz mono) → POST till ACRCloud /v1/identify (HMAC-SHA1)
        ▼
träff → { artist, track } → songKey = artist__track
        ▼
visa i /status (UI) + lightRecorder tar över record/replay på samma nyckel
```

## Ändringar per fil

### `pi/src/alsaMic.ts` (rå-PCM-tap)
- Lägg till en valbar capture-buffer som fylls i `onAudioData`-hot-path:en, bakom en flagga (`acrCaptureActive`). När inaktiv = noll extra arbete (V8 eliminerar grenen, samma mönster som DEBUG-flaggan).
- Tappa **rå vänster-kanal pre-gain/pre-EQ** (innan soft-clip/hi-shelf) för renast fingerprint, decimera 48k→8k (var 6:e sample), spara som Int16 mono i en pre-allokerad ringbuffer (~10s × 8k = 80k samples).
- Export: `startAcrCapture()`, `getAcrCaptureWav(): Buffer | null` (returnerar WAV-buffer när ~10s samlats, annars null), `stopAcrCapture()`.

### `pi/src/acrIdentify.ts` (ny)
- `identify(wav: Buffer): Promise<{ artist: string; track: string } | null>`.
- Bygger ACRCloud-signatur: `stringToSign = ["POST","/v1/identify",accessKey,"audio","1",timestamp].join("\n")`, `signature = base64(HMAC-SHA1(stringToSign, accessSecret))`.
- Multipart POST till `https://${ACRCLOUD_HOST}/v1/identify` med fälten `sample`, `sample_bytes`, `access_key`, `data_type=audio`, `signature_version=1`, `signature`, `timestamp`.
- Parsar `metadata.music[0]` → `{ artist: music.artists[0].name, track: music.title }`. Returnerar null vid no-match (`status.code !== 0`) eller saknade creds (loggar varning en gång).

### `pi/src/songIdentity.ts`
- Implementera `identifyViaAcr(wav)` så den delegerar till `acrIdentify.identify` och returnerar `songKeyFromParts(artist, track)` (samma slug-logik som `songKeyFromSonos`). Behåll signaturen bakåtkompatibel.

### `pi/src/lightRecorder.ts`
- Lägg till `acrEnabled` (persistas i storage, default false) + setter `setAcrMode(on)`.
- I `onSonosUpdate`: när `playing && !trackName && acrEnabled` och vi inte redan har en aktiv ACR-nyckel → starta `alsaMic.startAcrCapture()`, och efter ~10s kör identify. Vid träff sätt `currentKey` till ACR-nyckeln och kör samma record/replay-väg som idag (ladda sparad sekvens om auto-play på, annars spela in). Spara senaste identifierade `{ artist, track, key }` för UI.
- Lägg till `getAcrState()` → `{ acrEnabled, lastIdentified }`. En enkel cooldown (t.ex. 30s) så vi inte spammar ACRCloud när källan förblir okänd.

### `pi/src/index.ts`
- Ge `lightRecorder` referens till `alsaMic` (för capture-start) via befintlig `attachEngine`/ny `attachMic`-koppling i `startMicSubsystem`.

### `pi/src/configServer.ts`
- `GET /api/acr` → `getAcrState()`.
- `PUT /api/acr` `{ enabled: boolean }` → `setAcrMode`.
- Exponera senaste identifierade låt i `/status`-svaret (artist/track) för UI.

### `src/pages/PiMobile.tsx`
- I `RecordPlaybackPanel`: ny toggle **"Känn igen låt (ACRCloud)"** som läser/sätter `/api/acr`.
- Visa senast identifierad "Artist – Titel" när det finns (från `/api/acr` eller `/status`).

## Avgränsningar
- Ingen rå-ljud-upload till moln, ingen fingerprint per tick — bara en ~10s WAV per okänd passage (med cooldown).
- Ingen ändring av reaktiva engine-pathen eller BLE-trafik.
- ACR triggas aldrig när Sonos redan ger `trackName` (gratis-vägen behålls).

## Verifiering
- `npx tsc --noEmit` i pi-koden rent.
- Med ACR av: noll extra CPU i hot-path (capture-flagga false).
- Med ACR på + ingen Sonos-metadata: WAV byggs, POST görs, vid träff syns "Artist – Titel" i appen och record/replay använder den nyckeln.
- Saknade creds på Pi: tydlig engine-logg, ACR no-op, resten opåverkat.
