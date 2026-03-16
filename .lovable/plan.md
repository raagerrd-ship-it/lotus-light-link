

## Ta bort per-band extraSmooth, behåll enbart på slutsignalen

### Nuläge
Smoothing appliceras **två gånger**: först per-band (rad 306–313), sedan på slutlig pct (rad 322–326). Det ger dubbel-filtrering och diagrammet visar inte ren BLE-output.

### Ändring — `src/lib/engine/lightEngine.ts`

1. **Ta bort rad 306–313** (per-band extraSmooth-blocket) — behåll bara `const sm = cal.smoothing ?? 0;` för användning vid final pct
2. **Ta bort fälten** `extraSmoothBass` och `extraSmoothMidHi` från klassen
3. **Ta bort** dessa från `resetSmoothing()` och `destroy()`
4. **Behåll** `extraSmoothPct` och blocket rad 322–326 som enda smoothing-punkt

Resultat: diagrammet visar exakt det som skickas till BLE (smoothad pct), och smoothing-slidern styr enbart utsignalens mjukhet.

