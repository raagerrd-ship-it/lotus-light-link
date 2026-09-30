## KLART 2026-09-24 (huvudsessionen): enad analysator mergad + lotus live; Mio min mio = morgonagentens TEMPO_UP43, LIVE på lotus 09:00 (2/3 fångster rätt, korpus 171 -> 180/214).

## Från kvällen 2026-09-23 (huvudsessionen)
- BÄNKA "NORDENHOLM - Mio min mio" (facit 141,4 BPM, fångad flera gånger 17:42–17:44 UTC): analysatorn vandrade 92 → 140 → 105 → 99 under låten, vilket fick låset att pendla (ägaren såg fladder). Lotus-kal satt live 21:40: beatLockBeats 12, beatTrustDownMs 1500 (var 8 / 800). Mål: stabilt tempo, rätt oktav. Rapportera under 'Läsa låten'. BÄNKAT 21:50 (BENCH_FILTER=miominmio, 3 fångster): standard 96/90/96 (klass 3/2 på alla tre), live 108/108/140 (4/3, 4/3, rätt), live+ENV_S 16 109/91/140, evidence ensam = live. INGEN befintlig variant klarar den. Trolig orsak: 3+3+2-rytm (punkterade fjärdedelar) där kamfiltret ger fantomer på 3/4 och 2/3 av perioden. Idé att pröva som opt-in: fantomdomaren (träffandel 1,0 rätt / 0,75 för 4/3 / 0,67 för 3/2, analyser.ts ~rad 952–968) ska jämföra kandidaten mot 4/3×kandidaten också när kandidaten är den lägre; mät mot hela korpusen + syntet, inte bara låten.

KLART 2026-09-24: LOTUS_TEMPO_UP43=1 (ac41aab, main, standard AV) — korpus 171→180/214, test 81→86/104, syntet 6/8, Mio 2/3 (141/96/140). EJ deployad: kräver deploy-analyser-dir.py + rad i tempo-variant.conf efter ögat.
KLART 2026-09-24 (uppdrag 1 ur rutinen): branch enad-analysator (lotus 9986032, dmx 1dcd0df) — samma analyser/split/worker/tempo/recorder i båda, paritet 0 avvikelser, inspelning ute (grep 0), md5-spärr i deployskripten. Ej mergad/deployad.

## Morgonen 2026-09-24 — kalibrering
Ingen PUT. beatTempoSmoothS kvar 15 (spann 48/44/45 > 40, men höjt 12→15 först 09-23 — väntar tre dygn med 15). beatOctaveRule kvar false (loggen 1/1–1/2, y < 5).

## Morgonen 2026-09-27 — kalibrering
Ingen PUT. PC:n nådde inte Pi:n 09-24 22:16 → 09-27 18:31 (WinError 10065) ⇒ nattjobben 25–27 utan lärrader/hälsa; smoothS kvar 15 (tre dygns spann saknas), oktavregeln kvar false (1/1, y < 5). Notera: kalibreringen har beatLockBeats 12 och anchorOffsetDb 4 (inte agentens ändring).

## Morgonen 2026-09-28 — kalibrering
Ingen PUT. smoothS kvar 15 (spann 32 i dag, 09-25–27 saknas ⇒ inga tre dygn), oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 1,0, onset 1,0/0,9). Drops edgeAgo 09-27: n 67, median 0, p75 21 ms. Obs: pc.phase (gridLag/pulse) saknas i dygnets lärrader.

## Morgonen 2026-09-29 — kalibrering
Ingen PUT. smoothS kvar 15 (spann 50 i dag, 32 i går, 09-27 saknas), oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 0,8, onset 0,9/0,9). Drops edgeAgo 09-28: n 92, median 0, p75 13 ms. pc.phase.pulse n = 0 i ALLA snuttar sedan 09-24 21:00: kalibreringen har energyGridTrust 99 ⇒ gridet driver aldrig (energiläge 100 %) ⇒ gridsläp/pulsfas omätbara. Beslut åt ägaren: är heart-beat på lotus avsiktligt av? Nattjobbets SECTION_ENV saknar Pi:ns LOTUS_SECTION_EARLY_S=45 och LOTUS_SECTION_ON_HINT=1.

## Från kvällen 2026-09-29 (INFO, inget att utföra)
Nivåkanalens lag bänkad av huvudsessionen: ≤75 ms går inte utan snabbare fall, och fallet är LÅST (ägaren: "vill inte ha snabbare fade-down"). Föreslå inte lag-idéer via fall/release. energyRiseK 10 (r +0,05, lag oförändrad) väntar på ägarens ögonprov — PUT:a inte själv. Nattens 100 ms-raster underskattar lagen (fin: 150 sim / 180 verkligt).

## Från kvällen 2026-09-29 (UPPDRAG)
KLART 2026-09-30: Pi kör 7479418 (repo rätt); bundeln ombyggd 585990f, spökfiler i REMOVE 5bb8d5a; unitbas 200 på Pi mot 96+semi4 i repo, watchdog.sh gammal, config.json har oanvända nycklar — installera unit/watchdog i ladan.
Backup av ladans Pi-DMX finns i C:\Users\richa\Desktop\Claude\dmx-control\pi-dmx\pi-backup\2026-09-29\ (README.md, manifest.txt, pidmx-backup.tgz). Gör steg 4d (Drift och stallar) för DMX offline mot den: jämför md5 av dist/*.js i manifestet mot ett rent bygge av dmx-control main (pi-dmx/engine, `npx tsc -p .`), unit + drop-ins (heap.conf, ladan.conf) mot repots systemd/audio-dmx-engine.service och tools/ladan.py, samt config.json mot src/config.ts standardvärden. Lista varje avvikelse med vilken sida som är rätt enligt git/minnet (pi-dmx.md). Rätta repot vid ren drift (t.ex. heap.conf-flaggorna ska stå i repots unit); ändra inget på Pi:n (onåbar). Leta också efter samma felklass som GC-stallarna: flaggor, filer eller inställningar som bara finns på ena sidan. Rapportera under 'Drift och stallar'.

## Från kvällen 2026-09-29 sent (UPPDRAG, DMX, bänk offline)
KLART 2026-09-30: UNDERPEAK_MIN 1,5 redo för kod (pop 11→7, mega 31→29, bortfallna alla <1,5 dB); NEED_DIP redo för kod (pop falsk 111 s bort); vidga saknade sektionstagg → DMX_VIDGA_SECTION opt-in 00b65ab, ta ur SHOW_ENV tills ögat sett (lookval ändras 29–59 %).
Ladan kör flera PROV (se dmx-control/pi-dmx/engine/tools/ladan.py SHOW_ENV). Bänka offline (showStory/dropBench/effectMix på pop_ladan + megamix_ladan med SHOW_ENV) och rapportera 'redo för kod' eller 'ta bort' per prov: (1) DROP_UNDERPEAK_MIN 1.5 – räkna dropfire per inspelning med/utan (dropBench:s utskrift visade inte fyrningarna 09-29 – kör med DMX_DROP_TRACE=1 och räkna [dropfire]-rader), jämför med ägarens markeringar i dmx-control/pi-dmx/pi-backup/2026-09-29/drop-markeringar.txt; (2) effekten 'vidga' valdes ALDRIG i showStory – ta reda på varför (rotation/pool/fitScore/krav) och föreslå fix; (3) DMX_BOUNDARY_NEED_DIP – låtgränser per inspelning med/utan (megamix har låtbyten utan paus). Ändra inget på Pi:n.

## Morgonen 2026-09-30 — kalibrering
Ingen PUT. smoothS kvar 15 (spann 38/50/32 — inte > 40 tre dygn), oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 1,0 men bara 3 facit; onset 0,9/0,9 på < 8 låtar). Drops edgeAgo 09-29: n 34, median 0, p75 35 ms. DRIFT: heap.conf (NODE_OPTIONS=--max-old-space-size=144) är VERKNINGSLÖS — ExecStart har --max-old-space-size=224 som vinner (heap_size_limit 227 MB mätt på Pi:n); repo = Pi. GC 09-29 16–24: 48 pauser ≥ 20 ms, max 66 ms, alla kind 4 (inkrementell märkning, inte scavenge). Beslut åt ägaren: A/B 144 mot 224 en kväll (ta bort flaggan ur ExecStart), mät [gc]-raderna.
