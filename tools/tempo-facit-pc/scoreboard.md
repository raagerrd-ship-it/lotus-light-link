# Resultattavla — analysatorns tempoval mot facit

Uppdaterad 2026-09-22 04:54. Korpus = riktiga snuttar med PC-facit (växer), syntet = 8 kända tempon. Cell = korpus rätt/n · syntet rätt/n.

Cell = korpus rätt/n · syntet rätt/n · on-beat-recall (andel PC-slag med analysatorkick inom ±60 ms) · kickprecision. Bänk = live-läge (BENCH_GRID=1).

| datum | standard | live | evidence | ring10 | live-cd80 | live-cd120 | live: dygnets låtar | ok-andel | grid-släp | onset recall | onset precision | nivå r |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.22 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-19 | 3/14 · 6/8 | – | 1/14 · 6/8 | 3/14 · 6/8 | – | – | 116 (37 facit) | 0.47 | 4.5 ms | 0.4 | 0.8 | 0.4 |
| 2026-09-20 | 39/76 · 6/8 | – | 44/76 · 6/8 | 43/76 · 6/8 | – | – | 113 (96 facit) | 0.34 | -1 ms | 0.3 | 0.8 | 0.3 |
| 2026-09-21 | 181/288 · 6/8 · slag 0.59 p 0.83 | 226/288 · 6/8 · slag 0.90 p 0.81 · fas 102/148 | 212/288 · 6/8 · slag 0.61 p 0.83 | 188/288 · 6/8 · slag 0.58 p 0.83 | 226/288 · 6/8 · slag 0.91 p 0.81 · fas 102/148 | 226/288 · 6/8 · slag 0.86 p 0.82 · fas 102/148 | 161 (118 facit) | 0.79 | 5.7 ms | 0.9 | 0.8 | 0.4 |
| 2026-09-22 | 51/70 · 6/8 · slag 0.58 p 0.82 | 55/70 · 6/8 · slag 0.95 p 0.81 | 56/70 · 6/8 · slag 0.61 p 0.81 | 53/70 · 6/8 · slag 0.57 p 0.82 | 55/70 · 6/8 · slag 0.96 p 0.81 | 55/70 · 6/8 · slag 0.90 p 0.82 | 189 (146 facit) | 0.8 | 9.9 ms | 0.9 | 0.8 | 0.3 |

Senaste dygnet: domar {"ok": 74, "utan facit": 40, "avvisat": 7, "ok-oktav-2": 6, "ingen dom": 57, "ok-fantom-1.50": 2, "ok-fantom-1.33": 3}; kick-bias 0.0 ms; nivå-lag 500.0 ms; analysatorns spann inom låt 48 BPM (median); tempoledtrådar ≠ 1: 37; dropfångster 115 {"ratt": 26, "falsk": 15, "osaker": 74}.

Live = det som kör på Pi:n (tempo-variant.conf), standard = utan flaggor. En variant ska slå live med minst 3 låtar på ≥ 36 korpuslåtar utan att tappa på syntet innan den provas live (drop-in-flagga, backup, återgång). Kickvarianter (cd80/cd120) döms på on-beat-recall utan precisionsförlust > 0,02.
