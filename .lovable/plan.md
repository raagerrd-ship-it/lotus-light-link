

# Separera ljusstyrning till ett återanvändbart bibliotek

## Nuvarande struktur

All logik lever i `src/lib/` och `src/components/MicPanel.tsx`. Det mesta i `src/lib/` är redan ren logik utan React-beroenden, men MicPanel binder ihop allt: mikrofon-init, FFT, AGC, smoothing, BLE-sändning, diagramdata och UI-canvas.

## Föreslaget lager-uppdelning

```text
┌─────────────────────────────────────────────┐
│  src/lib/engine/  (portabelt, ingen React)  │
│                                             │
│  bledom.ts        BLE-protokoll & anslut    │
│  bleStore.ts      Anslutningsstatus         │
│  audioAnalysis.ts FFT-bandanalys            │
│  agc.ts           Gain control              │
│  brightnessEngine.ts  Smoothing & dynamik   │
│  lightCalibration.ts  Kalibrering & presets │
│  colorExtract.ts  Färgextraktion            │
│  lightEngine.ts   ★ NY: Huvudloop-orkestrator│
│                                             │
├─────────────────────────────────────────────┤
│  src/lib/ui/  (projekt-specifikt)           │
│                                             │
│  chartStore.ts    Diagramdata               │
│  drawChart.ts     Canvas-ritning            │
│  debugStore.ts    Debug-data                │
│  pipelineTimings.ts  Latens-mätning         │
└─────────────────────────────────────────────┘
```

## Nyckelförändring: `lightEngine.ts`

En ny klass `LightEngine` som kapslar hela realtidsloopen — det som idag lever inuti MicPanel:

- **`start()`** — Initierar mikrofon, AudioContext, Worker, startar tick-loop
- **`stop()`** — Stänger ner allt rent
- **`setColor(rgb)`** — Uppdatera basfärg (från album art etc)
- **`setVolume(vol)`** — Uppdatera volymnivå
- **`setPlaying(bool)`** — Växla aktiv/idle
- **`setTrackName(name)`** — Triggra AGC-reset vid låtbyte
- **`onTick(callback)`** — Hook för varje tick med all data (brightness, color, bands, isPunch etc)
- Ingen DOM-åtkomst, ingen React, inga chart-refs

## MicPanel blir tunn

MicPanel reduceras till:
1. Skapa `LightEngine`-instans i useEffect
2. Synka props → engine-metoder
3. `onTick` → pusha chart-samples + rita canvas
4. All logik (AGC, smoothing, BLE) lever i engine

## Vad som kan återanvändas i annat projekt

Kopiera `src/lib/engine/`-mappen + `tick-worker.js`. Importera `LightEngine`, koppla BLE, sätt färg — klar. Ingen React behövs.

## Steg

1. Skapa `src/lib/engine/`-mappen och flytta dit: `bledom.ts`, `bleStore.ts`, `audioAnalysis.ts`, `agc.ts`, `brightnessEngine.ts`, `lightCalibration.ts`, `colorExtract.ts`
2. Skapa `src/lib/engine/lightEngine.ts` — extrahera tick-loopen ur MicPanel till en ren EventEmitter-klass
3. Flytta `chartStore.ts`, `drawChart.ts`, `debugStore.ts`, `pipelineTimings.ts` till `src/lib/ui/`
4. Uppdatera alla import-sökvägar i hela projektet
5. Reducera MicPanel till en tunn wrapper som använder `LightEngine`
6. Uppdatera Index.tsx och övriga filer med nya import-paths

