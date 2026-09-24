## KLART 2026-09-24 (huvudsessionen): enad analysator mergad + lotus live; Mio min mio = morgonagentens TEMPO_UP43, LIVE på lotus 09:00 (2/3 fångster rätt, korpus 171 -> 180/214).

## Från kvällen 2026-09-23 (huvudsessionen)
- BÄNKA "NORDENHOLM - Mio min mio" (facit 141,4 BPM, fångad flera gånger 17:42–17:44 UTC): analysatorn vandrade 92 → 140 → 105 → 99 under låten, vilket fick låset att pendla (ägaren såg fladder). Lotus-kal satt live 21:40: beatLockBeats 12, beatTrustDownMs 1500 (var 8 / 800). Mål: stabilt tempo, rätt oktav. Rapportera under 'Läsa låten'. BÄNKAT 21:50 (BENCH_FILTER=miominmio, 3 fångster): standard 96/90/96 (klass 3/2 på alla tre), live 108/108/140 (4/3, 4/3, rätt), live+ENV_S 16 109/91/140, evidence ensam = live. INGEN befintlig variant klarar den. Trolig orsak: 3+3+2-rytm (punkterade fjärdedelar) där kamfiltret ger fantomer på 3/4 och 2/3 av perioden. Idé att pröva som opt-in: fantomdomaren (träffandel 1,0 rätt / 0,75 för 4/3 / 0,67 för 3/2, analyser.ts ~rad 952–968) ska jämföra kandidaten mot 4/3×kandidaten också när kandidaten är den lägre; mät mot hela korpusen + syntet, inte bara låten.

KLART 2026-09-24: LOTUS_TEMPO_UP43=1 (ac41aab, main, standard AV) — korpus 171→180/214, test 81→86/104, syntet 6/8, Mio 2/3 (141/96/140). EJ deployad: kräver deploy-analyser-dir.py + rad i tempo-variant.conf efter ögat.
KLART 2026-09-24 (uppdrag 1 ur rutinen): branch enad-analysator (lotus 9986032, dmx 1dcd0df) — samma analyser/split/worker/tempo/recorder i båda, paritet 0 avvikelser, inspelning ute (grep 0), md5-spärr i deployskripten. Ej mergad/deployad.

## Morgonen 2026-09-24 — kalibrering
Ingen PUT. beatTempoSmoothS kvar 15 (spann 48/44/45 > 40, men höjt 12→15 först 09-23 — väntar tre dygn med 15). beatOctaveRule kvar false (loggen 1/1–1/2, y < 5).
