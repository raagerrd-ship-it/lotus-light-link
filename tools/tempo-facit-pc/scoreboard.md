# Resultattavla — analysatorns tempoval mot facit

Uppdaterad 2026-09-23 08:34. Korpus = riktiga snuttar med PC-facit (växer), syntet = 8 kända tempon. Cell = korpus rätt/n · syntet rätt/n.

Cell = korpus rätt/n · syntet rätt/n · on-beat-recall (andel PC-slag med analysatorkick inom ±60 ms) · kickprecision. Bänk = live-läge (BENCH_GRID=1).

| datum | standard | live | evidence | ring10 | live-cd80 | live-cd120 | live: dygnets låtar | ok-andel | grid-släp | onset recall | onset precision | nivå r |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.22 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.47 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-20 | 39/76 · 6/8 | – | 44/76 · 6/8 | 43/76 · 6/8 | – | – | 113 (96 facit) | 0.34 | -1 ms | 0.3 | 0.8 | 0.3 |
| 2026-09-21 | 181/288 · 6/8 · slag 0.59 p 0.83 | 226/288 · 6/8 · slag 0.90 p 0.81 · fas 102/148 | 212/288 · 6/8 · slag 0.61 p 0.83 | 188/288 · 6/8 · slag 0.58 p 0.83 | 226/288 · 6/8 · slag 0.91 p 0.81 · fas 102/148 | 226/288 · 6/8 · slag 0.86 p 0.82 · fas 102/148 | 161 (118 facit) | 0.79 | 5.7 ms | 0.9 | 0.8 | 0.4 |
| 2026-09-22 | 51/70 · 6/8 · slag 0.58 p 0.82 | 55/70 · 6/8 · slag 0.95 p 0.81 | 56/70 · 6/8 · slag 0.61 p 0.81 | 53/70 · 6/8 · slag 0.57 p 0.82 | 55/70 · 6/8 · slag 0.96 p 0.81 | 55/70 · 6/8 · slag 0.90 p 0.82 | 189 (146 facit) | 0.8 | 9.9 ms | 0.9 | 0.8 | 0.3 |
| 2026-09-23 | 99/142 · 6/8 · slag 0.57 p 0.83 | 112/142 · 6/8 · slag 0.94 p 0.82 | 113/142 · 6/8 · slag 0.59 p 0.83 | 106/142 · 6/8 · slag 0.57 p 0.83 | 112/142 · 6/8 · slag 0.94 p 0.82 | 112/142 · 6/8 · slag 0.89 p 0.83 | – (– facit) | – | – ms | – | – | – |

Senaste dygnet: domar null; kick-bias None ms; nivå-lag None ms; analysatorns spann inom låt None BPM (median); tempoledtrådar ≠ 1: None; dropfångster None null.

Live = det som kör på Pi:n (tempo-variant.conf), standard = utan flaggor. En variant ska slå live med minst 3 låtar på ≥ 36 korpuslåtar utan att tappa på syntet innan den provas live (drop-in-flagga, backup, återgång). Kickvarianter (cd80/cd120) döms på on-beat-recall utan precisionsförlust > 0,02.

Sektioner (Pi-flaggor {"LOTUS_SECTION": "1", "LOTUS_GRID_PHASE": "1", "LOTUS_SECTION_REPEAT": "117"}, repeats {"filer": 91, "rc": 0, "tail": "", "err": ""}):

- test-tier: high==high 0.61 · recall 0.71 · falsk 0.49 · gransfel 0.25 (n 38) | refrang 2 <=4 s 4/17, <=8 s 8, median 9.4 s · refrang 1 <=4 s 1 · vers 2 ej high 0.4 · forutsedd 2 | forutsagelse 9/72 @ 2.0/min
- test-repeat: high==high 0.61 · recall 0.71 · falsk 0.49 · gransfel 0.25 (n 38) | refrang 2 <=4 s 9/33, <=8 s 18, median 5.1 s · refrang 1 <=4 s 6 · vers 2 ej high 0.54 · forutsedd 5 | forutsagelse 9/72 @ 2.0/min
- alla-tier: high==high 0.6 · recall 0.69 · falsk 0.49 · gransfel 0.3 (n 82) | refrang 2 <=4 s 5/39, <=8 s 16, median 10.4 s · refrang 1 <=4 s 4 · vers 2 ej high 0.54 · forutsedd 4 | forutsagelse 16/148 @ 2.0/min
- alla-repeat: high==high 0.6 · recall 0.69 · falsk 0.49 · gransfel 0.3 (n 82) | refrang 2 <=4 s 17/66, <=8 s 33, median 6.1 s · refrang 1 <=4 s 12 · vers 2 ej high 0.51 · forutsedd 8 | forutsagelse 16/148 @ 2.0/min

Tolkning: tier = energirang-proxy (forsta high = refrang 1, andra = refrang 2), repeat = akustisk upprepning (repeat_facit.py). Tuna pa train (BENCH_SPLIT=train), rapportera test; en sektionsandring provas live bara om den vinner pa test mot BADA faciten.
