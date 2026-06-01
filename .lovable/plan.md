## Mål

En dedikerad **Låt-studio**-vy *inuti* PiMobile (ingen separat app). När en inspelning avslutas finslipar Pi:n sekvensen **automatiskt** och sparar den polerade versionen. I Studion kan du granska analys + före/efter, **förhandsgranska** live på slingan, och **ångra** tillbaka till råinspelningen.

All analys/finslipning sker på Pi:n (där rådatan och motorn redan finns). Ingen onlineapp behövs — webbläsaren är bara fjärrkontrollen.

```text
Inspelning klar (låtbyte/paus)
        │
        ▼
seqPolish.polish()  ──►  sparar <key>.json (polerad)
        │                + <key>.raw.json (original, för ångra)
        ▼
auto-play spelar redan den polerade versionen

PiMobile / Låt-studio
   ──► GET  /api/light-seq/:key          (frames + analys, raw vs polerad)
   ──► POST /api/light-seq/:key/preview  (spela vald version på slingan)
   ──► POST /api/light-seq/:key/revert   (återställ till rå + polera om)
```

## Vad "finslipning" gör (DSP på Pi, ingen AI)

Sekvensen är frames `[tMs, pct, r, g, b]` ~25 Hz. Finslipningen kör rena signalsteg:

1. **Luck-utfyllnad** — interpolerar över tappade frames/glapp så uppspelningen inte hackar.
2. **Mjukare övergångar** — lätt temporal utjämning av brightness/färg (samma release-kurva som motorn) för att ta bort flimmer.
3. **Normalisering** — skalar brightness så dynamiken utnyttjar hela spannet utan att klippa.
4. **Transient-bevarande** — skarpa beat-träffar jämnas inte bort.

Analys som visas: längd, antal frames, glapp/dropouts, brightness-spann (min/snitt/max), flimmer-nivå — så du ser vad som förbättrades.

## Pi-sida

**Ny fil `pi/src/seqPolish.ts`**
- `analyze(frames)` → `{ durationMs, frameCount, gaps, brightnessMin/Avg/Max, flicker }`.
- `polish(frames)` → ny frames-array enligt stegen ovan.

**`pi/src/lightRecorder.ts`**
- I `finalizeRecording()`: efter att rå-bufferten skrivits, kör `polish()` automatiskt — spara originalet en gång som `<key>.raw.json` och skriv den polerade till `<key>.json`. Auto-play läser därmed alltid den polerade.
- `getSequence(key)` → fulla frames + `analyze()` för både rå och polerad version.
- `previewSequence(key, variant)` → `engine.setPlaybackSequence(frames)` från pos 0, oberoende av Sonos; återställ efteråt.
- `revertSequence(key)` → kopiera tillbaka `<key>.raw.json` → `<key>.json` (och polera om).

**`pi/src/configServer.ts`** — endpoints:
- `GET  /api/light-seq/:key` → `{ raw: analysis, polished: analysis }`
- `POST /api/light-seq/:key/preview` → body `{ variant: 'raw' | 'polished' }`
- `POST /api/light-seq/:key/revert` → `{ ok }`

(`/api/light-seq/list` och `DELETE` finns redan och återanvänds.)

## UI-sida (PiMobile)

**Ny route `/pi-mobile/song`** (egen vy, inte ny app) registreras i routern bredvid `/pi-mobile`.

- Listar inspelade sekvenser (återanvänder `/api/light-seq/list`).
- Klick på en sekvens → detalj: analys-kort med **före/efter**-jämförelse (längd, frames, glapp, brightness-spann, flimmer), knappar **Förhandsgranska rå**, **Förhandsgranska polerad**, **Ångra (återställ rå)** och **Radera**.
- I nuvarande `RecordPlaybackPanel` läggs en liten länk "Öppna Låt-studio →". Befintliga toggles (inspelning/auto-play/ACR) lämnas orörda.

## Avgränsningar

- Ingen separat app, ingen onlineapp, ingen AI — bara DSP på Pi.
- Auto-finslipning vid varje avslutad inspelning; original alltid sparat (`.raw.json`) → fullt ångerbart.
- Inga ändringar i motorns realtidskedja eller ACR-flödet.

## Verifiering

- `npx tsc --noEmit` i `pi/` rent.
- Manuellt: spela in en låt → vid låtbyte finslipas den automatiskt → öppna Låt-studio → före/efter skiljer sig → Förhandsgranska polerad spelar jämnare på slingan → Ångra återställer rå-versionen.
