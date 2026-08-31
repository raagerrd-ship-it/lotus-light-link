---
name: FIX 21 — pulsform, RISE_HOLD, beatLeadMs 132 och mjuk trust
description: onsetRiseMs 40 + onsetRiseHoldK 2.0 (annars svälter pulsen i den multiplikativa kedjan), beatLeadMs 132, shapeSmoothUpMs 25, lightSmoothMs 55, trust som utjämnad conf-ramp med golv 0.35, FRAME_RECORDER som mätverktyg
type: feature
---

**Mätverktyget först.** `FRAME_RECORDER` i `piEngine.ts`: sätt `cal.recordFrames` till ett NYTT
värde → N rader (`tms,pct,phase,bpm,trust,shape,boost`) skrivs till `$PCC_DATA_DIR/frames.csv`, en
per faktiskt skickad BLE-ram (~53 Hz). **Behåll det.** HTTP-pollning samplar för glest för pulsformen
och 33 Hz-polling försämrar mätbart det den mäter på en Zero 2W. Samma sak gäller `wdbSlow`/
`anchorDb` i `pipeline`-diagnostiken.

**RISE_HOLD är obligatorisk.** `onsetRiseMs 0` gav uppsteg median 26 enheter = strobe. Med rise men
utan hold jagade boosten ett fallande mål (`onsetTarget *= decay` i samma ram) → boost p50 0.10 av
0.45, och eftersom kedjan är multiplikativ (`energyForm = ceil × ((1-bd) + bd·pn)`) strypte det HELA
energikopplingen: shape 0.90–1.00 gav bara pct 62. Håll målet stilla medan boosten klättrar,
`ceil(onsetRiseMs × onsetRiseHoldK / FRAME_MS)` ramar — hålltiden måste vara **bunden**, en EMA når
aldrig riktigt fram. Efter: pn 0.56 → 0.90, pct p90 83, uppsteg 4/11/19.

**`beatLeadMs` följer rise-tiden.** Toppen låg 87 ms efter triggern (fasvikning); + ~45 ms
utsignalslatens = **132**. Verifierad synk −8 ms vid 18,7 ms ramkvantisering. De 45 ms är en
budgetuppskattning, inte optiskt mätt.

**Trust är inte binär.** `MIN_BEAT_CONFIDENCE` 0.20 släppte igenom mycket svag takt med fullt
pulsdjup, och `locked` flippade 4×/3 min. Nu: ramp `beatTrustLoConf 0.30 → beatTrustHiConf 0.70`,
EMA `beatTrustSmoothMs 400` (conf kan falla 0.79 → 0.00 mellan två ramar), **golv
`beatTrustFloor 0.35`** — golvet är den viktigare halvan: med trust → 0 blir `energyForm = ceil`
rakt av, lugnt men dött, och `bd` skalar även transient-vägen. Tre lägen: stadig takt → fullt djup
på rutnätet · otydlig takt → grunt djup på transienter · ingen takt → lugn andning. På låt med tydlig
takt låg trust 1,00 i 91 % av tiden. Exponeras i `beat`-blocket.

**`shapeSmoothUpMs 25`** (250 kvävde allt, 50 trögt, 15 → strobe, 0 → fladder mellan slagen).
`lightSmoothMs 55`. Spann/lyft-per-sekund mellan olika inspelningar är materialberoende — bara
pulshöjd och synk är solida (mäts inom samma inspelning).
