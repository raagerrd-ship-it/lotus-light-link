## Mål

Spela in med **max upplösning** från en **oförvrängd källa**, processa offline till en polerad sekvens som matchar BLE-utskicket, och **radera rå-källan** efter processning. Slut på att spela in längst ner i kedjan (BLE-utskick, 25 Hz, hålig) — vi spelar in högt upp, före ljus-estetiken läggs på.

## Källa: FFT-band/flux-strömmen (100 Hz)

Tre möjliga tapp-punkter, från råast till mest processad:

```text
1. Rått PCM (48 kHz)        renast, men kräver offline-FFT + ~7–23 MB/låt
2. FFT-band/flux (100 Hz)   musikinnehåll FÖRE ljus-estetik  ← VÄLJS
3. Engine-tick pct/färg     redan "förvrängd" av inställningar (dagens tapp ligger ännu lägre)
```

Vi väljer **(2)**: enginen räknar redan ut band+flux 100 ggr/sek (`getLatestBands` / `onFluxReady` i `alsaMic.ts`). Det är din "rena signal" — dynamikcentrum, gamma, färg och utjämning appliceras *efteråt*. Att spela in den ger:

- **4× tätare** upplösning än idag (100 Hz mot 25 Hz), helt utan hål → `fillGaps` blir nästan onödig.
- En källa **oberoende av BLE-rate-limit, no-change-undertryckning och nätverksjitter**.
- Möjlighet att **rendera om ljus offline** med valfria inställningar och köra **tyngre beat-analys** än Pi Zero 2W hinner i realtid.

Rått PCM (alternativ 1) lämnas som möjlig framtida uppgradering om vi vill om-tuna själva FFT:n — men det är en separat, mycket större insats.

## Arkitektur

```text
INSPELNING (realtid, lätt)
  alsaMic onFFTReady ──► recorder buffrar [tMs, bass, midHi, flux, totalRms] @100Hz
                         (positionsankrat mot Sonos, som idag)
        │  vid låtbyte/paus
        ▼
  spara <key>.analysis.json   (rå analys-ström, ~120 KB/låt)

PROCESSNING (offline, tyngre, körs direkt efter inspelning)
  renderLightFromAnalysis(analysis, settings)  ──► ljus-frames [tMs, pct, r,g,b] @100Hz
        │   (återanvänder enginens band→pct/färg/gamma-mappning som ren funktion)
        ▼
  seqPolish.polish(frames)    ──► polerad sekvens
        ▼
  spara <key>.json (spelas upp)   +   RADERA <key>.analysis.json

UPPSPELNING
  oförändrad: setPlaybackSequence(polerad), positionsankring + auto-sync
```

## Ändringar

### `pi/src/piEngine.ts`
- Bryt ut den rena mappningen **band → pct + färg (inkl. dynamik, gamma, punch)** ur tick-loopen till en exporterad ren funktion `renderFrameFromBands(bands, state, consts)`. Realtidsticket anropar samma funktion → noll beteendeförändring live.

### `pi/src/seqRender.ts` (ny)
- `renderLightFromAnalysis(analysisFrames, settings)`: kör `renderFrameFromBands` per analys-frame med en offline-version av dynamik-/onset-state. Här kan vi köra en **rikare beat/tempo-analys på flux** (utan realtids-CPU-tak) som matar `seqPolish`.

### `pi/src/lightRecorder.ts`
- Lägg till **analys-tap**: prenumerera på `onFFTReady`/`onFluxReady`, buffra `[tMs, bass, midHi, flux, totalRms]` @100 Hz (ersätter dagens 25 Hz `onFrame`-buffert som inspelningskälla; `onFrame`/frame-tap behålls för auto-sync-korrelationen).
- `finalizeRecording()`: skriv `<key>.analysis.json`, kör `renderLightFromAnalysis` → `polish` → skriv `<key>.json`, **radera** `.analysis.json`. Behåll fallback: om render/polish fallerar, logga och hoppa över (ingen trasig låt).
- Höj `MAX_FRAMES` för 100 Hz (~4 min × 100 = 24 000 → sätt tak ~80 000).
- `revertSequence`: ångra blir "rendera om från analysen" — men eftersom analysen raderas behöver vi behålla `.analysis.json` tills nästa lyckade render, **alternativt** behålla den som ångra-källa (omvärdera: behålla analysen ~120 KB är billigt och ger äkta ångra/om-tuning). **Beslut:** behåll `.analysis.json` som ångra-/om-render-källa istället för att radera direkt — uppfyller "rå kan tas bort" men ger om-tuning gratis. Radering kan ske manuellt/vid lågt diskutrymme.

### `pi/src/seqPolish.ts`
- Skala om frame-beroende konstanter från 40 ms → 10 ms (100 Hz): beat-fönster, refraktär, tail, gap-trösklar uttrycks i ms och räknas om mot ny frame-takt.

## Avvägning som beslutas i planen
- **Radera vs behålla analysen:** vi *kan* radera efter render (din önskan), men `.analysis.json` är så liten (~120 KB) att vi föreslår att **behålla den** som ångra-/om-render-källa. Den polerade `.json` är det som spelas. Säg till om du hellre vill radera hårt efter varje render.

## Verifiering
- `npx tsc -p tsconfig.json` rent; bumpa version.
- Spela in en låt → vid låtbyte renderas + poleras automatiskt → Låt-studio visar fler frames, ~0 gaps, stabilare bpm jämfört med dagens 25 Hz-tapp.
- Live-beteendet oförändrat (samma `renderFrameFromBands` i realtidsticket).

## Frågor kvar
1. Behålla `.analysis.json` för ångra/om-tuning (rekommenderas), eller radera hårt efter render?
2. Räcker FFT-band/flux som "rå" källa, eller vill du ha rått PCM (separat, större bygge) trots marginell extra vinst för själva ljusshowet?
