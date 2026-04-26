## Problem

BLEDOM-lampan visar blekta/pastellaktiga färger istället för mättade. Orsak: vi skalar RGB med brightness (`r * scale`) **och** skickar brightness-byten separat. BLEDOM-firmware multiplicerar då internt en gång till och blandar in vitt för att "balansera" energin → pastell istället för mättad ton.

Idle-läget ser rätt ut eftersom `setIdleColor()` alltid använder `brightness = 0xff` (ingen dubbel-skalning).

## Lösning

Skicka **mättat RGB** (oförändrat `r,g,b`) till lampan och låt **enbart brightness-byten** (`cbr`) styra ljusstyrkan. BLEDOM dimmar då rent internt utan vit-injektion.

## Ändring

**Fil:** `pi/src/ble/protocol.ts` (rad ~258–264 i `sendToBLE`)

Före:
```ts
const scale = brightnessToScale(brightness);
const cr = (r * scale + 0.5) | 0;
const cg = (g * scale + 0.5) | 0;
const cb = (b * scale + 0.5) | 0;
const cbr = (scale * 0xff + 0.5) | 0;
```

Efter:
```ts
// BLEDOM-quirk: skala INTE RGB med brightness — firmware blandar då in vitt
// för att kompensera energi-balans → blekta färger. Skicka mättat RGB och
// låt brightness-byten ensam styra dimningen.
const scale = brightnessToScale(brightness);
const cr = r;
const cg = g;
const cb = b;
const cbr = (scale * 0xff + 0.5) | 0;
```

## Sidoeffekter (positiva)

- **Delta-skip blir bättre**: `cr/cg/cb` ändras nu bara vid faktisk färgbyte, inte vid brightness-pulser. Mer `skipDeltaCount`, mindre BLE-trafik på låtar med stabil palette.
- **UI "Output-färg"** (`getLastSent()` → `/api/status`) visar nu mättad ton. `brightness`-fältet finns separat så UI kan dimma visuellt om så önskas.
- **Perceptual gamma-LUT (1.8)** är intakt — den bygger fortfarande `cbr`.
- **Color-tween, dynamics, punch white, flicker deadband** påverkas inte.

## Memory

Lägger till `mem://pi/ble/bledom-rgb-saturation.md` som constraint så jag inte råkar återinföra RGB-skalningen igen, plus rad i index.

## Verifiering

- `npx tsc --noEmit`
- I drift: spela låt med stark röd cover → ren röd, inte rosa. Bass-kicks ändrar luminans, inte hue.
