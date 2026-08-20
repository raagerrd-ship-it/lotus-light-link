# audio-analyser

Portable, framework-agnostic audio analyser for reactive lighting / visualisers.
Feed hop-sized mono Float32 PCM, get back a `Frame` with musical features.

Zero project coupling — only external dependency is [`fft.js`](https://www.npmjs.com/package/fft.js).

## Source of truth

**Master lives in the `DMX Control` project (`pi-dmx/engine/src/analyser.ts`).**
This copy is a mirror. When DMX-analysern får uppdateringar (BPM-intervall,
drop-grindar, kick-detektor, trum-envelopes) måste denna fil re-synkas manuellt
tills vi lyfter ut den till ett delat repo. Ändra INTE här utan att först ändra
i DMX Control — annars divergerar de och vi får två analysatorer med olika buggar.

Synkad från DMX Control commit: **`39eb98fd`**

Diff mot master vid nästa re-synk:

```bash
git log 39eb98fd..HEAD -- pi-dmx/engine/src/analyser.ts
```

Varje commit i DMX-repo:t bär sina mätvärden i meddelandet — läs dem innan du
kopierar hit, så vet du vad som ändrats i beteende (BPM-intervall, drop-grindar,
kick-detektor, trum-envelopes) och varför.

## Kalibrering — hop-takt

Analysatorns interna konstanter (BIG_EVERY=3, kickSeed<400, per-band-onset-
medianfönster) är intrimmade för **~375 Hz hop-takt** (128 samples @ 48 kHz).
Kör du en annan hop-storlek måste du antingen (a) tappa audio i egen 128-hop
och driva analysatorn separat, eller (b) omkalibrera de tidskonstanter som inte
skalar via `dtHop` (se `INTEGRATION.md`).



## Install into another project

Copy the whole `audio-analyser/` folder in, then:

```bash
npm install fft.js
```

## Quick start

```ts
import { createAnalyser } from './audio-analyser';

const analyser = createAnalyser({ sampleRate: 48000, hopSize: 480 });

// Per hop (mono Float32, length === hopSize):
const frame = analyser.process(samples);

console.log(frame.level, frame.kick, frame.bpm, frame.spec.bass);
```

## What you get in `Frame`

| Field | Range | What it means |
|---|---|---|
| `level` / `levelRaw` / `levelVU` | 0..1 | Smoothed / raw / VU-ballistic loudness |
| `energy` / `mid` / `treble` | 0..1 | Coarse spectral energy |
| `centroid` | 0..1 | Dark → bright spectral tilt |
| `flux` | 0..1 | Bass-band spectral flux (change) |
| `kick` | bool | True on rising edge of a detected kick |
| `bpm` / `bpmConfidence` | 80..160 / 0..1 | Locked tempo + how sure |
| `beatAnchorMs` | ms wall-clock | Sub-hop-refined phase of last kick |
| `intensity` | 0..1 | Section energy vs song's own average |
| `dropCount` | monotone | +1 per detected drop (edge-safe) |
| `inZone` / `breaking` | bool | Sustained top zone / breakdown |
| `buildUp` / `inRiser` | 0..1 / bool | Tension ramp toward a drop |
| `profile.{punch,bass,bright,beat}` | 0..1 each | ~8s character of the track |
| `spec.{sub,kick,bass,lowMid,mid,highMid,treble,air}` | 0..1 each | Per-band level (per-band AGC) |
| `onset.{...same bands...}` | 0..1 each | Per-band adaptive-threshold onset |
| `drum.{kick,snare,hat,bass}` | 0..1 each | Peak-hold envelopes for kit hits |

## Design

Two parallel FFTs on the same sliding buffer:

- **512 @ every hop** — RMS, kick, coarse flux, BPM autocorrelation.
- **2048 @ every 3rd hop** — 8-band log spectrum + per-band onsets (23 Hz/bin).

The 2048-FFT is decimated to keep the whole pipeline realtime on a Pi Zero 2W.
The returned `Frame` is a single reused object (mutated per hop) — zero
allocation in the hot path.

## Notes

- Auto-gain runs unless `setGainLock(true, fixedGain)` is called.
- Optional external beat-grid gate: `setBeatGrid({ bpm, anchorMs })` will
  reject kick candidates that don't land near the grid. Set `null` (default) to
  disable.
- `hopSize` should match your source's chunk size (e.g. 480 for 100 Hz @ 48k).
- Extracted from [DMX Control](https://github.com/) — semantics identical to the
  live engine there.
