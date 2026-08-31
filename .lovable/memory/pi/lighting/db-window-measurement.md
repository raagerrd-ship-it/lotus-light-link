---
name: dB-fönstret — anchorOffsetDb = TAK, windowDb = GOLV
description: windowDb 10 + anchorOffsetDb 4.5. Mät wdb/wdbSlow/anchorDb i 2 Hz och räkna shape i efterhand på identisk insignal; smalare windowDb gör det SÄMRE.
type: feature
---
`anchorDb = wdbSlow + anchorOffsetDb`, `shape = (wdb - (anchorDb - windowDb)) / windowDb`.

- **`anchorOffsetDb` styr TAKET.** Mättnad: 4,0 → 8,4 % · 4,5 → 5,6 % · 5,0 → 3,4 % · 5,8 → 1,6 %,
  oberoende av bredden.
- **`windowDb` styr GOLVET** (`anchorDb − windowDb`). Att smalna gör det SÄMRE: 7 dB gav 26,0 % mot
  golvet mot 13,3 % vid 9 dB. Bredare fönster minskar spridningen mellan låtar (golv-spann 29,4 → 14,1).
- **Valt: windowDb 10, anchorOffsetDb 4.5.** shape p90 0,98; pct p90 85, max 100, andel ≥90 6,5 %.

Mätmetod: exponera `wdb`, `wdbSlow`, `anchorDb` i `/api/diagnostics.pipeline`, spela in i ≤2 Hz och
räkna kandidaterna i efterhand på SAMMA data. Tunga mätskript (33 Hz-polling) försämrar ljuset mätbart
på en Zero 2W — samma fälla som `arecord`-hälsokontrollen.

Övrigt låst: `shapeSmoothUpMs 50` är känsligaste ratten (250 kvävde dynamiken, 0 gav fladder),
`flickerDeadband 0` för musik, `beatLeadMs 45` är btmon-verifierad — inte en användarratt.
`subdivHalveAboveBpm 145`: takt-regeln har FÖRETRÄDE över energigrinden (`_bpmWants !== null` →
auktoritativ, annars energi, annars `else if (_halveAbove <= 0) next = 0`).
