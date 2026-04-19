---
name: Oktav-baserad bandnormalisering
description: pi/src/alsaMic.ts beräknar bass/midHi-RMS som energy-per-octave istället för per-bin för att matcha mänsklig perception
type: feature
---
Tidigare implementation delade total-power med antal FFT-bins per band:
- bas (60-150 Hz) = 3 bins
- mid+hi (150-22050 Hz) = ~510 bins

Detta gjorde att samma energi-per-Hz i diskant gav ~100x lägre RMS än i bas. Resultatet: VU-metern visade nästan bara bas (20%) medan disk fastnade på 0-1%.

**Lösning** (pi/src/alsaMic.ts): Dela total-power per band med antalet OKTAVER bandet täcker (`Math.log2(highHz/lowHz)`):
- bas: 60–150 Hz = 1.32 oktaver
- mid+hi: 150–15000 Hz = 6.64 oktaver

`rawBass = sqrt(loSum * INV_LO_OCT)` där `INV_LO_OCT = 1 / LO_OCTAVES`.

Detta matchar hur människan uppfattar frekvensbalans (logaritmiskt) och gör att VU-meterns disk-stapel rör sig ordentligt vid diskant-rik musik.

Build tag: `2026-04-19/oktav-band-normalisering`
