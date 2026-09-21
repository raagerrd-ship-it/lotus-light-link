# Resultattavla — analysatorns tempoval mot facit

Uppdaterad 2026-09-21 11:36. Korpus = riktiga snuttar med PC-facit (växer), syntet = 8 kända tempon. Cell = korpus rätt/n · syntet rätt/n.

Cell = korpus rätt/n · syntet rätt/n · on-beat-recall (andel PC-slag med analysatorkick inom ±60 ms) · kickprecision. Bänk = live-läge (BENCH_GRID=1).

| datum | standard | live | evidence | ring10 | live-cd80 | live-cd120 | live: dygnets låtar | ok-andel | grid-släp | onset recall | onset precision | nivå r |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.22 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.47 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-20 | 39/76 · 6/8 | – | 44/76 · 6/8 | 43/76 · 6/8 | – | – | 113 (96 facit) | 0.34 | -1 ms | 0.3 | 0.8 | 0.3 |
| 2026-09-21 | 181/288 · 6/8 · slag 0.59 p 0.83 | 226/288 · 6/8 · slag 0.90 p 0.81 · fas 102/148 | 212/288 · 6/8 · slag 0.61 p 0.83 | 188/288 · 6/8 · slag 0.58 p 0.83 | 226/288 · 6/8 · slag 0.91 p 0.81 · fas 102/148 | 226/288 · 6/8 · slag 0.86 p 0.82 · fas 102/148 | 161 (118 facit) | 0.79 | 5.7 ms | 0.9 | 0.8 | 0.4 |

Senaste dygnet: domar {"ingen dom": 32, "ok": 69, "avvisat": 7, "utan facit": 42, "ok-fantom-0.75": 2, "ok-fantom-1.50": 1, "ok-fantom-1.33": 3, "ok-oktav-2": 5}; kick-bias 0.2 ms; nivå-lag 400.0 ms; analysatorns spann inom låt 48.0 BPM (median); tempoledtrådar ≠ 1: 37; dropfångster 61 {"ratt": 12, "falsk": 11, "osaker": 38}.

Live = det som kör på Pi:n (tempo-variant.conf), standard = utan flaggor. En variant ska slå live med minst 3 låtar på ≥ 36 korpuslåtar utan att tappa på syntet innan den provas live (drop-in-flagga, backup, återgång). Kickvarianter (cd80/cd120) döms på on-beat-recall utan precisionsförlust > 0,02.
