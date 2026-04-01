

## Optimera BLE-kommandon med minimum-ändringströskel

### Vad
Lägg till en "delta-gate" i `sendToBLE` — skippa sändning om skillnaden mot senast skickade värde är under en tröskel (default ~3% av 255 ≈ 8 steg). Detta minskar antalet skickade kommandon avsevärt vid långsamma fades utan att påverka snabba förändringar.

### Ändring — en fil: `src/lib/engine/bledom.ts`

1. Byt ut den exakta dedup-checken (rad 272) mot en **delta-check**: beräkna `maxDelta = max(|cr-_lastR|, |cg-_lastG|, |cb-_lastB|, |cbr-_lastBr|)` och skippa om `maxDelta < MIN_DELTA` (default 8, ~3% av 255)
2. Lägg till ny räknare `bleSkipDeltaCount` i `debugStore.ts` och visa i debug-overlayen
3. Nollställ räknaren vid låtbyte (MicPanel.tsx)

### Teknisk detalj
```text
sendToBLE()
  ├─ delta < 8? → skip (NY — ersätter exakt dedup)
  ├─ throttle: för snart? → skip
  └─ write
```

Delta-gaten subsumerar den gamla exakta dedupen (delta 0 fångas också). En enda check istället för två.

