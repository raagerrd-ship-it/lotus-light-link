---
name: Dirigent v2 — brightness från intensity
description: Brightness-formen drivs av frame.intensity; rå amplitud är bara långsam loudness-skala för tyst/låg volym.
type: feature
---
Dirigent v2 (2026-08-25): `frame.levelVU` och `lightRawRms × micGain` var uppmätt
för platta inom låt och fick ljuset att ligga runt ~50 %. Brightness-formen ska
därför komma från analysatorns `frame.intensity` (sektionsenergi: breakdown lågt,
uppbyggnad/topp högt), med liten additiv onset/flux-punch.

Formeln i motorn:

```text
energyForm = clamp(smoothed(frame.intensity) + onsetBoost)
loudnessRaw = slow envelope(lightRawRms × tvåpunktsGain)
loudness = clamp(0.65 + loudnessRaw × ceilingSensitivity × 0.35)
brightness = floorN + energyForm × (1 - floorN) × loudness
```

Rå amplitud får alltså bara skilja tyst/låg volym från normal/loud låt — den får
inte bära uppbyggnader eller breakdowns. `levelVU` driver aldrig ljus-formen.