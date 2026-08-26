---
name: Adaptivt tak + pre-drop-svällning (bryggeri)
description: inLow/inHigh följer en långsam EMA (~7s) av level per låt (adaptiveCeiling), och frame.buildUp lyfter energyForm via buildUpGain. Bryggeri-defaults (lugnt, inte party).
type: feature
---
LED-slingan sitter i ett bryggeri → lugnt/ambient. Två permanenta motor-ändringar i `piEngine.tickInner` (v1.0.775):

**1. Adaptivt tak** (ersätter fast inLow/inHigh när `adaptiveCeiling !== false`):
```text
_slowMean += (level - _slowMean) * (FRAME_MS / ceilFollowMs)   // symmetrisk, långsam
m      = max(ceilFloor, _slowMean)
inLow  = m * ceilLowMul
inHigh = m * ceilHighMul
```
Varje låt normaliseras till sin egen energi → höga låtar pinnar inte, lugna låtar behåller dynamik.
Golvet (`ceilFloor`) hindrar att en tyst låt drar upp taket på brus. Detta är en MILD, LÅNGSAM anpassning
av BARA taket — inte den förbjudna per-beat-AGC:n på ljus-tappen. `adaptiveCeiling=false` ger exakt gamla
fasta beteendet (`inLowFrac`/`inHighFrac` × point1.gain) → riskfri toggle.

**2. Pre-drop-svällning:** `energyForm += frame.buildUp * buildUpGain` → ljuset sväller IN i droppen i stället
för reaktiv vit blixt. `dropSensitivity` förblir drop-rattens (återanvändes bara i live-testet).
`frame.buildUp` exponeras som `live.buildUp` i `/api/status`.

**Bryggeri-defaults:** gain point1 {12,12} / point2 {45,1.2}, brightnessFloor 25, releaseAlpha 0.4,
shapeExpand 2.0, barAccent 1.0, transientGain 0.2, beatLeadMs 45, buildUpGain 0.25,
adaptiveCeiling true · ceilFollowMs 7000 · ceilFloor 0.12 · ceilLowMul 0.55 · ceilHighMul 1.35.
`inLowFrac 0.022` / `inHighFrac 0.075` kvar för fast-läge-fallbacken.
