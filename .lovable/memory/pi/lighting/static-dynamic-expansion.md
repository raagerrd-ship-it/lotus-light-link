---
name: Statisk dynamik-expansion på formen
description: level (totalRms) sträcks från inLowFrac/inHighFrac × point1.gain till 0..1 med exponenten shapeExpand, FÖRE peakBoost/smoothing. Fasta tal, ingen AGC.
type: feature
---
Uppmätt v772 (16 053 sampel, gain 20): `level` p2=0.18, p50=0.42, p95=0.62, max=0.82 →
0→1-svinget användes aldrig. Fix (v1.0.773) i `piEngine.tickInner`, före peakBoost:

```text
gRef   = cal.gainCalibration.point1.gain || 20
inLow  = inLowFrac  (0.009) × gRef
inHigh = inHighFrac (0.031) × gRef
e      = clamp((level - inLow) / (inHigh - inLow))
shape  = e ^ shapeExpand      // 1.0 = linjär
```

Trösklarna binds till gainens primärpunkt → skalar med gain-omkalibrering men inte med
Sonos-volym (level är redan volym-kompenserat). Ingen AGC, ingen dynamicCenter, inga profiler.
`brightnessFloor` default 25 → **10**. `barAccent` default 1.0 → **1.8** (heartbeat på ettan).
UI: "Dynamik (kontrast)"-slider 1.0–2.5 styr `shapeExpand`.
