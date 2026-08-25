---
name: frame-ms-75hz
description: Motorns sanna frame-takt är 75 Hz (FRAME_MS 13.33 ms), inte 100 Hz; fftMs=10 kvar medvetet
type: feature
---
`FRAME_MS = ANALYSER_HOP(128) * BAND_EVERY_HOPS(5) / 48000 * 1000 = 13.333 ms` (75 Hz) exporteras från `pi/src/alsaMic.ts`. Det är den sanna dirigent-takten — alla gamla "100 Hz"-kommentarer var fel.

- `initOnsetBuffer()` använder `Math.round(175 / FRAME_MS)` ≈ 13 frames (~175 ms). Den tar INTE längre `tickMs` (som bara pacar BLE-slot-leasen).
- `computeTickConstants`: `fftMs = 10` behålls MEDVETET. Onset-alforna (`onsetRiseAlphaFft`/`onsetDecayFft`) och refraktären (`onsetRefractoryMs / 10`) är gehörs-trimmade mot 100 Hz-antagelsen. Byte till FRAME_MS gör punchen ~33 % snabbare och remappar persisterade värden → endast som live-trim.
- Drop-konstanterna (FAST_ALPHA/SLOW_ALPHA/REFRACTORY_FRAMES) är också 100 Hz-kalibrerade; orörda eftersom `dropEnabled=false`.
