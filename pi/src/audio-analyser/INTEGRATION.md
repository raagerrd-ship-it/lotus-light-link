# Integrating audio-analyser

Two integration patterns:

## 1. Standalone (recommended for new projects)

```ts
import { createAnalyser } from './audio-analyser';

const analyser = createAnalyser({
  sampleRate: 48000,
  hopSize: 480,          // 100 Hz frame rate
  autoGainTarget: 0.15,  // optional
  tauUp: 3,              // optional
  tauDown: 8,            // optional
  noiseFloor: 0.002,     // optional
});

// From ALSA / Web Audio / any hop-driven source:
function onHop(samples: Float32Array) {
  const frame = analyser.process(samples);
  driveLights(frame);
}
```

## 2. Alongside an existing FFT pipeline (Lotus pattern)

Lotus feeds its ALSA ring buffer to both its own 1024-FFT (for legacy
`BandResult`) **and** the analyser (for the richer `Frame`). See
`pi/src/alsaMic.ts` — the analyser is fed a hop-sized slice of raw
(pre-window) samples inside `processFFT()`, and the frame is exposed via
`getLatestFrame()`.

## Reset / lifecycle

- `analyser.resetGain(startGain?)` — after routing changes (mic ↔ line).
- `analyser.setGainLock(true, 1)` — when the source is at fixed line level.
- `analyser.setBeatGrid({ bpm, anchorMs })` — if you have an external PLL and
  want kick candidates gated to the grid. Pass `null` to disable.

## Requirements

- Node 18+ (uses `Float32Array`, `performance.now()`).
- `fft.js` runtime dependency.
- Hop size divides the sample rate cleanly. 480 @ 48000 = 100 Hz frames is the
  tested configuration.

## Performance

Measured on a Pi Zero 2W with 480-sample hops @ 48 kHz:

- 512-FFT + kick + BPM every hop: ~0.8 ms
- 2048-FFT + 8-band analysis every 3rd hop: ~2.6 ms (avg ~0.9 ms per hop)

Total ≈ 1.7 ms per hop → ~17% of the 10 ms hop budget. Plenty of headroom.
