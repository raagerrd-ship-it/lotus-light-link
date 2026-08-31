---
name: Energibevarande färg-tween (ENERGY_LERP)
description: Palett-tweenen i piEngine interpolerar i ljusenergi (kvadrera → lerp → sqrt), inte linjär sRGB; colorFadeMs 3000 gjorde annars rött→grönt brunt
type: feature
---
`colorFadeMs` är 3000 ms, så linjär sRGB-lerp passerade (128,128,0) — mörkt smutsgult — mellan
komplementfärger. Tweenen gör i stället `c = sqrt((1-k)·c² + k·t²)` per kanal.

- Detta är INTE gammakorrektion: `lutR/lutG/lutB` ligger kvar nedströms (kanalkalibrering).
- Kostnad: 3 `Math.sqrt` per ram vid 53 Hz = 159/s; motorn ligger på 21 % av en kärna.
- Förkastat på mätdata: fjäderfysik på onset-decay (översläng = strobe) och temporal dithering
  (kräver >100 Hz; vi skickar 53 GATT-paket/s och PWM:en sitter i remsans egen styrkrets).
