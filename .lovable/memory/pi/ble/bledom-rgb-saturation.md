---
name: BLEDOM RGB skickas alltid mättat
description: sendToBLE skalar ALDRIG RGB med brightness. Endast brightness-byten (cbr) styr dimning. RGB-skalning triggar BLEDOM-firmware-quirk som blandar in vitt → blekta färger.
type: constraint
---

## Regel
I `pi/src/ble/protocol.ts` `sendToBLE()` skickas `r,g,b` **oförändrat** till lampan. Endast `cbr` (brightness-byte) skalas via `brightnessToScale()`.

```ts
const scale = brightnessToScale(brightness);
const cr = r;            // mättat — INTE r * scale
const cg = g;            // mättat
const cb = b;            // mättat
const cbr = (scale * 0xff + 0.5) | 0;  // dimning sker här
```

## Varför
BLEDOM-firmware multiplicerar internt RGB × brightness. Om vi också pre-skalar RGB blir det dubbel multiplikation, och firmware kompenserar genom att blanda in vitt för "energi-balans" → mättad röd blir blekrosa, mättad blå blir ljusblå.

Perceptual gamma-LUT (γ=1.8, 101 entries) är fortfarande aktiv på `cbr`, så dimningskurvan är intakt.

## Sidoeffekt
Delta-skip (`BLE_DELTA_SKIP_ENABLED`) blir mer aggressiv eftersom `cr/cg/cb` nu bara ändras vid faktisk färgbyte, inte vid brightness-pulser. Önskat beteende.

## Återinför INTE
Om någon i framtiden "fixar" att färgen ser ljus ut vid hög brightness genom att lägga tillbaka `r * scale` — det är fel väg. Quirken är fysisk i lampans firmware.
