# Portabel audio-analyser: dela mellan DMX och Lotus

Analysatorn i DMX Control är den mest välarbetade delen av båda projekten (dubbel-FFT, per-band onsets, BPM-lock, drop/riser, karaktärsprofil, noll-alloc/hop). Vi gör den till ett fristående paket — precis som `ble-driver/` — och drar in den i Lotus.

## Mål

1. En mapp, `pi/src/audio-analyser/`, som är helt fristående (bara `fft.js` som extern dep). Kopieras rakt in i andra projekt.
2. Lotus ersätter sin egna FFT/bass-flux/onset-logik i `alsaMic.ts` + `piEngine.ts` med analysatorns `Frame`.
3. Ingen förändring i UI-beteende med dagens `cal` — de fem nya signalerna (`bpm`, `intensity`, `dropCount`, `buildUp`, `profile`) blir tillgängliga men driver inget nytt än.

## Steg

**1. Extrahera modulen (från DMX → hit)**
- Kopiera in `analyser.ts` som `pi/src/audio-analyser/analyser.ts`.
- Bryt beroendet till `EngineConfig`: byt konstruktor till `new Analyser({ sampleRate, hopSize })`. Bort med `cfg.audio.rate` / `cfg.fft.hop`-look-ups.
- Behåll `Frame`, `Spectrum` som publika typer.
- Skapa `pi/src/audio-analyser/index.ts` med `createAnalyser({ sampleRate, hopSize })` (samma mönster som `createLampDriver`).
- Lägg till `README.md` + `INTEGRATION.md` med API-yta och exempel.

**2. Wire in i Lotus mic-pipen**
- `alsaMic.ts` matar redan hops via `onFFTReady`. Byt så att den istället matar `analyser.process(hopSamples, hopMs)` och exponerar `getLatestFrame(): Frame`.
- Ta bort Lotus egna `bassFlux`/onset-räkning + `setBeatCutoffHz` (analysatorns 8-bands per-band onset ersätter beat-cutoff-slidern med något bättre).
- `resetFluxState()` blir `analyser.resetGain()`.

**3. Wire in i piEngine**
- `tickInner` konsumerar `Frame` istället för `latestBands`.
- Mappning som håller nuvarande beteende oförändrat:
  - Nuvarande `bass` → `frame.spec.kick + frame.spec.bass` (viktat).
  - Nuvarande onset-boost → `frame.onset.kick`.
  - Nuvarande drop → `frame.dropCount` (monoton edge-jämförelse).
  - Nuvarande punch-white → tröskel på `frame.onset.kick` som förut.
- Nya signaler exponeras via `/api/status` för framtida bruk: `bpm`, `bpmConfidence`, `intensity`, `buildUp`, `profile`.

**4. Städa**
- Ta bort `pi/src/fftRadix2.ts` om inget annat använder den (analysatorn har egen `fft.js`).
- Ta bort `beatCutoffHz` från `LightCalibration` + UI-slider (analysatorns per-band onset gör den obsolet). Migrations-kod: ignorera fältet vid load.

**5. Verifiera**
- `npx tsc` i `pi/` grön.
- Manuell körning: motorn ska bete sig exakt som idag för normal reaktion. `bpm > 0` inom ~3s efter musik startar.

## Vad detta INTE gör

- Ingen ny UI. `bpm`/`intensity`/`buildUp`/`profile` är bara tillgängliga — vi bygger inte pulse-on-beat, drop-orkestrering eller mood-auto-select nu.
- Rör inte DMX-projektet. Vi kopierar hit och håller den som "canonical copy" i Lotus tills du bestämmer var master ska ligga. Om du vill kan vi senare ändra DMX att importera från Lotus istället (eller lägga modulen i ett tredje repo).

## Teknisk not

Analysatorns dubbel-FFT (512 timing + 2048 spektrum, sistnämnda decimerad till var 3:e hop) är designad för 48kHz @ 480 hop = 100Hz. Lotus alsaMic kör redan 48kHz @ 480 hop → drop-in-passform, ingen omkonfiguration.

`Frame` är ett återanvänt objekt (muteras per hop). Trådsäkert eftersom Node är single-threaded och `piEngine` läser synkront i samma tick.
