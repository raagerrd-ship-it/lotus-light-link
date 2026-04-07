

## BLE Fade-test — "Accelererande trappa"

### Koncept
Pi:n kör en fade-sekvens (0→255→0) på en kanal (t.ex. rött) med ökande hastighet per steg. Varje steg har fler fade-steg per sekund. Mobilen visar live vilken hastighet (w/s) som körs. Användaren trycker "Stopp" när lampan slutar se mjuk ut — det är din BLE-gräns.

### Steg

```text
Steg 1:  10 w/s  — fade 0→255→0 i ~25 steg (långsam, tydlig)
Steg 2:  20 w/s  — samma fade, dubbelt så snabbt
Steg 3:  30 w/s
Steg 4:  40 w/s
Steg 5:  50 w/s
...upp till 100 w/s
```

Varje steg kör 2 fulla cykler (upp+ner), sedan kort paus, sedan nästa steg.

### Tekniska ändringar

**1. `pi/src/configServer.ts`** — Ny endpoint `POST /api/ble-fade-test`

- Importerar `sendToBLE`, `resetLastSent` från nobleBle
- Startar en fade-sekvens som körs helt server-side (ingen HTTP per steg)
- Varje steg: beräknar intervall = `1000 / targetWps`, kör fade 0→255→0 med `resetLastSent()` före varje write för att bypassa dedup
- Exponerar `GET /api/ble-fade-test/status` som returnerar `{ running, currentWps }` — mobilen pollar denna
- `POST /api/ble-fade-test/stop` avbryter testet, returnerar senaste wps

**2. `pi/src/nobleBle.ts`** — Ny export: `sendRawColor(r,g,b)`

- Skriver direkt till BLE utan dedup/brightness-scaling — specifikt för testet
- Återanvänder pre-allokerade buffern, sätter `writeInFlight = false` och `resetLastSent()` internt

**3. `src/pages/PiMobile.tsx`** — Ny sektion "⚡ BLE Hastighetstest"

- Knapp "Starta test" → `POST /api/ble-fade-test`
- Under körning: pollar `/api/ble-fade-test/status` var 500ms
- Visar stort tal: **"40 w/s"** med animerad progress-bar
- Knapp "Stopp — lampan hackar" → `POST /api/ble-fade-test/stop`
- Visar resultat: "Din lampa klarar ~40 w/s (25ms tickMs)"
- Erbjuder knapp "Använd detta" som sätter tickMs via befintlig `/api/tick-ms`

### Varför detta fungerar
- Hela faden körs lokalt på Pi:n — ingen nätverkslatens per steg
- Fire-and-forget är inget problem — vi mäter inte responstid, vi mäter visuellt resultat
- Fade (inte strobe) gör det lätt att se när lampan "tappar steg" och börjar hoppa

