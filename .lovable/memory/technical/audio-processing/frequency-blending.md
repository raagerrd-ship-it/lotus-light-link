---
name: frequency-blending
description: Bas/Disk-mix använder asymmetrisk dämpning runt 0.5 (neutral), inte crossfade
type: feature
---
Bas↔Disk-slidern (`cal.bassWeight`, 0..1) styr en **asymmetrisk dämpning** i `pi/src/piEngine.ts` ~rad 642:

```ts
const w = cal.bassWeight;
const bassGain  = w <= 0.5 ? w * 2 : 1;        // 0→0, 0.5→1, 1→1
const midHiGain = w >= 0.5 ? (1 - w) * 2 : 1;  // 0→1, 0.5→1, 1→0
energyNorm = bassNorm * bassGain + midHiNorm * midHiGain;
```

**Semantik:**
- `0.0` = bara disk (bas helt dämpad) — högpass-känsla
- `0.5` = neutral, **båda 100%** (ingen färgning, default för Normal)
- `1.0` = bara bas (disk helt dämpad) — lågpass-känsla
- Sidan man drar mot stannar alltid på 100%; "den andra" sidan dämpas linjärt.

Detta ersätter den tidigare crossfade-formeln (`bass*w + mid*(1-w)`) som alltid sänkte totala energin när slidern flyttades från 0.5.

Frekvensdelning vid 150 Hz oförändrad. Defaults: Lugn=0.7, Normal=0.5, Party=0.3, Custom=0.5.
