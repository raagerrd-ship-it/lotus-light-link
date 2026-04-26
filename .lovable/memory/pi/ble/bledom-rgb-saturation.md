---
name: BLEDOM RGB MÅSTE pre-skalas med brightness
description: I RGB-mode (0x03-packet) ignorerar BLEDOM brightness-byten. RGB-värdena ensamma styr både färg OCH ljusstyrka. Pre-skala alltid r,g,b med brightness — annars konstant max → vitt.
type: constraint
---

## Regel
I `pi/src/ble/protocol.ts` `sendToBLE()` MÅSTE RGB pre-skalas med brightness i RGB-mode:

```ts
const scale = brightnessToScale(brightness);
const cr = (r * scale + 0.5) | 0;
const cg = (g * scale + 0.5) | 0;
const cb = (b * scale + 0.5) | 0;
```

## Varför
BLEDOM RGB-packet `[0x7e, 0x07, 0x05, 0x03, R, G, B, 0x00, 0xef]` har ingen brightness-byte som lampan respekterar. Ljusstyrkan kommer enbart från amplituden i R/G/B. Om vi skickar mättat (255,0,0) oavsett brightness → lampan kör alltid full röd.

Brightness-packet `[0x7e, 0x04, 0x01, brightness, ...]` används bara i 'brightness'-mode (vita lampor utan RGB).

## Tidigare felaktig hypotes
2026-04-26 testades att skicka mättat RGB för att undvika antagen "white-injection quirk". Resultat: lampan visade konstant vit/max — bekräftar att RGB-amplituden ÄR dimningen.

Om färger ser pastellaktiga ut vid hög brightness är det förmodligen:
- Color tween / dynamics som blandar kanaler
- Gamma-kurva för aggressiv
- Albumcover som faktiskt har låg mättnad

Lös via `dimmingGamma`, color extraction eller dynamics — INTE genom att ta bort RGB-skalning.
