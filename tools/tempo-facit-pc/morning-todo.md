## Från kvällen 2026-10-27 (ägaren via DMX-sessionen: 'nya test för natten') - KICKFÄLTET (går före allt utom hälsan och kalibreringen)
DMX-nattagenten hittade i natt att gallop-felet i ladan är taktgridets fas: onset.kick är klampad 0/1 och står på 1 under hela bas-svallet,
så DMX:s vikning lägger slaget +130 ms efter kicken (fynd 10-27 i dmx-control/pi-dmx/engine/tools/natt/analysator-fynd.md - du har
markerat det TAGET). DMX:s eget prov (dB-stigning) rättade gridet och taktklockan 67 -> 83 % men flyttade sektionerna. Du äger delade
analysatorn (båda repona, manifest + paritet). Inget deployas utan ägaren; regler som förut (nedgången rörs aldrig, beatLeadMs aldrig upp).
1. BYGG DET OMÄTTADE KICKFÄLTET som NYTT ramfält (t.ex. onset.kickRise = kickbandets stigning i dB före klampningen, eller fbOn[1]
   före klampning), både i den snabba vägen (FAST_BANDS) och den gamla. Befintliga fält orörda -> paritet 0 på allt annat (analyserParity
   lotus, splitProof/konsertReplay dmx byte-identiskt). Bevis att fältet duger: toppen ligger på kickens ansats - på DMX:s gallop-klipp
   (dmx-control/pi-dmx/engine/tools/ladan-2026-10-26/video-20261026T182512-ljud-x4-norm17.wav, subbens ansats 7,23 + k x 0,4695 s inom varje
   10,24 s-varv) och pop_ladan: median avstånd topp -> ansats och andel inom +-15 ms. Skriv KLART <commit> i analysator-fynd.md 10-27.
2. KICK PÅ TOPPEN (fynd 10-19/10-22, bygger på 1): opt-in <prefix>KICK_PEAK=1 - frame.kick på det lokala maxet av det nya fältet över
   adaptiv tröskel i stället för flux-tröskeln. Döm i lotus-banken (kick r/p, on-beat, fas, live 396/503 får inte gå ner) och på DMX:s pop
   (fasresultant kick mot kickbandets anslag, i dag R 0,03-0,18). Paritet 0 med flaggan av.
3. FAST_BANDS PÅ LOTUS (DELVIS 10-27: falsk-high 0,35 -> 0,39): DMX kör FAST_BANDS ihop med SECTION_WIN 2 (sektionspoäng över 2 s) som tog
   tillbaka sektionstappet där. Bänka LOTUS_FAST_BANDS=1 + LOTUS_SECTION_WIN=2 ihop mot samma sektionsbänk. Håller det -> redo för källaren.
Rapportera i morgonens rad + scoreboard; markera avsnittet KLART/DELVIS.
DELVIS 2026-10-28: (1) KLART frame.kickRise (lotus 9d6899f4, dmx 493b5ce): basens dB-stigning över 6 hop = DMX FEED_RISE-talet; paritet 0 (33 750 hop, FAST_BANDS 0/1, split inline); gallop FAST_BANDS topp median +4 ms, 66/82 inom +-15 ms (onset.kick tyngdpunkt +92 ms, 0/82); utan FAST_BANDS -22 ms, 23/82; pop_ladan saknar pålitlig ansatsreferens. (2) KICK_PEAK ej byggd. (3) FAST_BANDS+SECTION_WIN 2 test tier: high==high 0,71->0,66, recall 0,75->0,76, falsk-high 0,35->0,35, gränsfel 0,40->0,43, refräng 2 <=8 s 1->3/7, förutsägelse 3/16 @ 2,8->2,4/min => blandat, EJ redo (n 8), ägarens val. fastbands-win2-sektionsbank-20261028.json.

## Från kvällen 2026-10-26 (ägaren via DMX-sessionen) - LATENS OCH OPTIMERING (går före allt utom hälsan och kalibreringen)
Ägaren: 'natten vill jag att agenterna skall jobba med latensen och optimering'. DMX-nattagenten gör samma sak på DMX-sidan i natt och
skriver fynd i den delade analysatorn till dmx-control/pi-dmx/engine/tools/natt/analysator-fynd.md - läs den FÖRST och ta fynden
(du äger ändringar i analyser.ts/split.ts/slowWorker.ts, i båda repona, manifest + paritet som vanligt). Inget deployas utan ägaren;
skriv 'redo för källaren' med kommando. Regler som förut: fade-down/nedgången rörs aldrig, beatLeadMs aldrig uppåt.
1. SNABBA BANDEN PÅ LOTUS: <prefix>FAST_BANDS=1 finns i delade analysatorn sedan 10-21 (DMX kör den som standard: ljusets bandfält 5 ms
   efter ljudet i stället för 21-27, riggens ljus ~15 ms tidigare, drops identiska). Bänka LOTUS_FAST_BANDS=1 i lotus-banken (live 396/503,
   syntet, on-beat, fas, drops, sektioner) + fältlatens; håller den -> redo för källaren. Om ljuset kommer tidigare: räkna om par-regeln
   (lead ~ 45 + ceil(2*rise/24)*24) och föreslå lägre lead - aldrig högre.
2. LATENSBUDGETEN PÅ LOTUS: mic -> analys -> BLE -> remsa i ms (period/buffer, hop, fönster per fält, tick, conn-interval, lead), vilka 2
   steg som går att korta. Jämför med DMX:s budget i analysator-fynd.md/nattrapporten.
3. OPTIMERING: de TAGNA men obyggda punkterna - computeBpm i små metoder (0 % TurboFan, fynd 10-18), process()-skräpet 54-73 B/hop,
   onset.kick-klampningen (fynd 10-22/10-23, kick på toppen). Bit-identiskt/paritet 0 där bara kostnaden ändras; /api/perf på lotus
   (minor/major/loop) före/efter som mått.
Rapportera i morgonens rad + scoreboard; markera DMX-fynden TAGET/KLART/AVVISAT.
DELVIS 2026-10-27: (1) LOTUS_FAST_BANDS=1 bänkad: tempo 396/503, syntet 6/8, kick r 0,80/p 0,86, on-beat 0,84, fas 219/362 = live (identiskt); sektioner test (tier) high==high 0,71->0,67, recall 0,75->0,73, falsk-high 0,35->0,39, gränsfel 0,40->0,43, refräng 2 <=4 s 1->2/7, förutsägelse 3/16 @ 2,8->3,2/min => EJ redo för källaren (falsk-high stiger, samma kickgrindseffekt som DMX:s 'hör ihop' 81->75). Fältlatens enl. DMX-mätningen på identisk kod: specAbs 21->5 ms = lotus nivåkanalens bas-andel (alsaMic lowShare ur specAbs). Nästa: låt sektionens kickgrind läsa 2048-vägens onset.kick så bara ljusfälten blir snabba. Lead orörd (energiläge). (2) budget i rapporten. (3) optimeringspunkterna ej byggda i dag.

## Från kvällen 2026-10-17 (INFO) - DMX-NATTAGENTEN SKRIVER OM LOTUS-MOTORNS SKRÄP I NATT
Ägaren gav natten till 10-18 åt skräpjakten: DMX-nattagenten (02:38) får, som engångsundantag, skriva lotus-motorns egna filer
(pi/src/piEngine.ts, alsaMic.ts, bassBody.ts, heartbeat/*.ts), bara bevisat byte-identiskt (tools/skrap/engineReplay.mjs) och pushar
före 07:00. Den delade analysatorn rörs inte. Inget deployas. Morgonagenten: läs nattens lotus-commit(s) och rapport, bänka som vanligt,
rör inte samma filer samma morgon. 10-17 LIVE på lotus: analysatorn 14:04 (4e264e9), v8Tiering + micvägen 14:45 (1a0365a).

## 2026-10-22 morgon (morgonagenten): ingen PUT. Bänk live 396/503 oförändrad. Inga nya DMX-fynd. OBS: nattjobbet kördes 13:00 när musiken just startat (12:59) → 5 sena tickar max 494 ms (tempo/cache-hämtningen); kör före musik.

## 2026-10-21 morgon (morgonagenten): ingen PUT. Bänk live 396/503 oförändrad. DMX-fynd 10-19 cfg-kopia KLART (split.ts kommentar, lotus b966344, dmx 6e08f41, split.js byte-identisk); 10-19 kick, 10-21 FAST_BANDS (latensidé −15..−20 ms) och 10-21 worker-stride TAGET, ej byggda.

## 2026-10-20 morgon (morgonagenten): ingen PUT. DMX-fyndet 10-20 KLART (lotus f71054e, dmx 19bebf7): SECTION_BODY_HIGH även i intro efter låtgräns, redo för ladan. Bänk oförändrad 396/503.

## 2026-10-19 morgon (morgonagenten): ingen PUT. Repo-kopior heap.conf/gc-track.conf = Pi (f922235). SECTION_BODY_HIGH opt-in i delade analysatorn (DMX-profilval, ej lotus). Skräpjaktens rest (riserStep/agcStep) ej angripen.

## 2026-10-18 dag (ägaren via DMX-sessionen) - LIVE PÅ LOTUS, RÄTTA INTE TILLBAKA
- Drop-in zz-heapgrow.conf (A/B, ägarens prov): --heap-growing-percent=200 i ExecStart (gamla minnet växer 3x levande i st f ~1,4x).
  Mätt 32 min: storstädning 0 st efter uppstarten (förr var 4,5:e min, slutpaus 19-28 ms + inkrementellt 25-57 ms), små GC oförändrade
  8-9/min <= 8 ms, loopfördröjning max 20-28 ms, minne 142/300 MB. Backa: rm filen, daemon-reload, restart.
- Drops AV (ägaren: "bara led-slinga runt rummet"): PUT /api/calibration {"dropEnabled":false}.
- 13:2x: heap-growing 200 PERMANENT i heap.conf (zz-heapgrow.conf borttagen) + låtbytesstädning gc-track.conf LOTUS_GC_TRACK=0.6
  (full GC vid Sonos-låtbyte bara när gamla minnet >= 60 % av gränsen; mätt 93-95 ms per städning). Av: ta bort gc-track.conf.
- Node på lotus-Pi:n är 24.18 (inte 18). GET /api/perf (perfStats) live. noble-patchen (pi/scripts/patch-noble-debug.py, postinstall).

## Från kvällen 2026-10-17 (ägaren via DMX-sessionen) - ANALYSATORNS SKRÄP: BORT MED ALLT LÖPANDE SKRÄP (går före allt utom hälsan)
KLART 2026-10-17 kväll (DMX-sessionen, ägaren bad om det direkt): kodfixen gjord i analyser.ts i båda repona (md5 656c093a), bevisad
(paritet 0 i 4 varianter, bänken live 396/503, syntet 6/8, on-beat 0,84; DMX 24/24 byte-identiska) - se Status i analysator-fynd.md.
Lotus 72 -> 18 kB/s skräp. EJ DEPLOYAT: kräver deploy-analyser-dir.py (md5-spärren) - ägarens beslut. Morgonagenten: bara RESTEN
nedan (riserStep/agcStep i mic-läge, ~12 kB/s, orsak okänd) och överväg samma V8-flagga för lotus (src/v8Tiering.ts i DMX).
Ägarens mål: få bort ALLT skräp analysatorn skapar löpande. Orsakerna är nu hittade och bevisade - läs dmx-control/pi-dmx/engine/tools/natt/
analysator-fynd.md avsnittet "ÖPPET 2026-10-17 kväll SKRÄPET HITTAT" (det ersätter morgonens gissningar). Kort:
1. computeBpm/dropStep deoptas på sällsynta grenar och V8 optimerar om först efter 3000 anrop (4 Hz ⇒ ~12 min otolkat, allt boxas):
   flytta de sällsynta grenarna till egna små metoder (dist-rader i fyndet). Flaggan --invocation-count-for-turbofan=100 bevisar det
   (computeBpm 66 -> 16-23 kB/s) men är processens val; lotus kan pröva samma flagga i sin unit.
2. Decimaltal som argument/returvärde till metoder som inte inlinas boxas per anrop: för dem via fält (initierade i konstruktorn).
   Recept + bevis: dmx-control/pi-dmx/engine/tools/skrap/skrapPatch1.py + skrapPatch2.py (på en dist-kopia: process 47 -> 6 kB/s,
   fillFrame 22 -> 0, intensityStep 5 -> 0, byte-identiskt).
3. Explicita allokeringar i sectionBlock och alignScore (listan i fyndet): scratch-buffertar och metoder i stället för slice/sort-kopior,
   objekt och closurer per block.
INTE: doubleFields på hela Analyser-objektet (prövat: dropStep 14 -> 72 kB/s).
Bevis: paritet 0 (båda repona, ANALYSER_SHARED.md5), bänken 396/503, och i dmx-control/pi-dmx/engine:
`node tools/allocProf.mjs tools/ladan-2026-10-14/lang-20261014T161434.wav --fran 300 [--dist <kopia>]` (UTAN --fran mäts uppvärmningen)
+ `node --allow-natives-syntax tools/skrap/optStat.mjs <wav> 600 --fran 300` (andel TurboFan). Mål: analysatorn i stabilt läge från
183 kB/s mot ~0. Deploya inte - skriv 'redo' + kommandot i rapporten. Markera "KLART <datum>: <en rad>" här och Status i fyndet.

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

## Morgonen 2026-10-01 — kalibrering
Ingen PUT. smoothS kvar 15 (spann 45/38/50 — inte > 40 tre dygn), oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 0,93 på 15 domar; onset 0,9/0,9). Drops edgeAgo 09-30: n 219, median 0, p75 27 ms. GC efter heap 144+semi 4 (09-30 20:10–, ~1,1 h musik): pauser/10 s 13,3 → 2,9, ≥ 20 ms ~12/h (förr 9/h), max 66 → 42 ms. STÖRSTA STALLEN = tempocachens synkrona sparning: 63 sena tickar median 165 ms efter 20:10 (2,2 s efter varje PC-dropdom/inlärning) → beslut åt ägaren: deploya agent/tempominne-0930 (e41fb5f+9912572). Drop-ins Pi = repo (bara kommentarer skiljer); analyser.js på Pi = 09-24 (känd drift, main bara opt-in/bit-identiskt).

## Morgonen 2026-10-02 — kalibrering
Ingen PUT. smoothS kvar 15 (spann 41,5/45/38 — inte > 40 tre dygn), oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 0,90 på 20 domar; onset 0,9/0,9). Drops edgeAgo 10-01: n 149, median 0, p75 21 ms. Tempominnet LIVE (10-01 17:26): stall efter inlärning 1/40 (443 ms) mot 63 × ~165 ms dygnet före. Kvar: 0,7–1,1 s stallar vid IGNITION (alsaMic-import + BLE-anslutning, 3 starter) → förslag åt ägaren: förladda alsaMic vid boot. GC ≥ 20 ms: 44, max 101 ms (kind 4, 01:44). Drift: drop-ins Pi = repo; dist = main utom analyser.js (känd) och configServer.js (radslut).

## Morgonen 2026-10-03 — kalibrering
PUT {"beatTempoSmoothS":18} FÖRSÖKT (spann 45/41,5/54 > 40 tre dygn, regeln) — NEKAD: "Engine bootar fortfarande" (IGNITION, ingen musik). Gör om nästa morgon om spannet fortfarande > 40 (återställ: {"beatTempoSmoothS":15}). Oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 0,86 = 64/74 med ok-prefix; onset 1,0/0,9). Drops edgeAgo 10-02: n 34, median 0, p75 533 ms (svans 1–5 s i rock). KORPUSTAKET (600 wav) gallrade 75/91 långfångster (_smu) 10-02 17:42– ⇒ sektionsbankens test 43 → 8; fix i tempo_facit.py (_smu undantas), facit-tjänsten omstartad 07:09. Drift: drop-ins = repo; dist = main utom analyser.js (känd) + heartbeat/contract.js (09-23, importeras ej på lotus).

## Morgonen 2026-10-04 — kalibrering
Ingen PUT. smoothS kvar 15: spannet 38,5 i dag (54/41,5 före) bryter tre-dygnsregeln ⇒ gårdagens nekade {"beatTempoSmoothS":18} görs INTE om. Oktavregeln kvar false (1/1, y < 5). Inga återgångar (ok-andel 3/5 = för få domar, 2 avvisade varav Journey live 98 vs 114; onset 0,9/0,9 på 6 låtar). Drops edgeAgo 10-03: n 53, median 0, p75 ~200 ms, 7 svansfall 2,7–20 s (insats långt före fyrning). Drift: drop-ins på Pi = repo (skillnad bara i kommentarer/CRLF), ExecStart 144/semi4/no-flush-bytecode = heap.conf. Stallar 10-03: 61 sena tickar ≥ 40 ms, 9 st 490–824 ms = IGNITION→MOTOR_ON (känt), ~10 st 100–330 ms mitt i musiken — GC friad ([gc]-raden max 6–21 ms i samma fönster), flera direkt efter '[tempo] inlärning'/'facit … avvisat' vid låtbyte (14:25:48 320 ms, 12:29:26 230 ms). Förslag: mät låtbytets synkrona arbete (cpuprofile runt inlärningsraden) innan något ändras.

## Från kvällen 2026-10-04 (INFO, ägarens beslut – inget att utföra)
Inspelning och periodisk loggning ligger nu BAKOM FELSÖKNING (lotus, deployat 17:15): fångsterna startar alltid AV (ingen sparad brytare), `[raster] period` och `[gc] 10 s` skrivs bara med felsökning på. Slå på: `PUT /api/debug/verbose {"enabled":true,"record":true}` (record = fångster till facit-PC:n), av: `{"enabled":false}` (stänger även fångsterna). Följd: korpusen växer inte och dygnets lärrader saknar ofta facit – det är AVSIKTLIGT, inget fel; slå inte på fångster själv. Rastervärdena finns kvar i /api/status (sync.raster). Dessutom i dag: lecup/hciconfig via bestående sh-hjälpare (sena tickar ≥ 40 ms 18/33 min → 2/20 min).

TILLÄGG 17:22: inspelaren laddas nu BARA med LOTUS_RECORDER=1 (drop-in + omstart), samma brytare som DMX_RECORDER — utan den importeras den inte alls och `record:true` i /api/debug/verbose ger record:false. Rutinen (SKILL.md) har fått blocket 'INSPELNING BAKOM FELSÖKNING … JAGA INTE KORPUSEN'.

## Från kvällen 2026-10-04 (UPPDRAG, två morgnar)
Uppvärmningen (alsaMic.warmUpAnalyserInBackground, portad från DMX warmup.ts, klipp /opt/lotus-light/warmup/warmup.wav) kör efter omstarten 05:00 och avbryts om micen är öppen. Den är OBEVISAD: 16:51 kördes den mitt i musik (deploy) och gav 17 sena tickar 44–430 ms – därav avbrottsskyddet. Mät nyttan:
- 10-05 (din körning ~07:00): kontrollera i engine.log att '[warmup] klar: 74 s ljud …' står efter 05:00-omstarten. Spelar ingen musik: slå PÅ felsökning (`PUT /api/debug/verbose {"enabled":true}`) och lämna den på (kostar lite; ägaren informerad) så att dagens första session får '[synk] sen tick'-rader.
- 10-06: räkna sena tickar ≥ 40 ms de första 120 s efter dygnets första '[Subsystem:mic] start' (10-05) och jämför med kallstarter utan uppvärmning (10-04 10:19 deploy: 903/726/210/77/52/100/750 ms på 15 s; 10-02 första session: 258/416/531/389 ms). Slå sedan AV felsökningen. Rapportera 'uppvärmning hjälper/hjälper inte' med siffrorna; hjälper den inte: föreslå LOTUS_WARMUP=0 (rör den inte själv).
Katalogslagningen (Deezer) ligger sedan 10-04 18:50 bakom felsökning: 'inget katalogtempo' på nya låtar är avsiktligt. Låtbytesstallen 120–145 ms var dess HTTPS-uppstart på huvudtråden (cpuprofile 16:48).

## Morgonen 2026-10-05 — kalibrering + uppvärmning dag 1
KLART 2026-10-05 (dag 1 av uppvärmningsuppdraget): '[warmup] klar: 74 s ljud, 27750 hop pa 16.6 s' 05:01:19; ingen musik ⇒ PUT /api/debug/verbose {"enabled":true} 07:05 (record:false), LÄMNAD PÅ. Dag 2 (10-06) kvar: sena tickar första 120 s efter dygnets första mic-start, jämför med kallstarter, slå AV felsökningen.
Ingen PUT. smoothS kvar 15 (spann 61/38,5/54 – inte tre dygn i rad, och 61 kommer från ljudböcker). Oktavregeln false (1/1). Inga återgångar/varianter (evidence 395 < live 400, cd80 +0,01). Bänken 451/567 → 400/572 = korpusbyte: 202 snuttar från 10-04 roterade in, 61 Alfons Åberg-ljudböcker (tal). Drops edgeAgo 10-04: n 411, median 0, p75 75 ms. Drift: drop-ins = repo, dist = main utom kända analyser.js/heartbeat/contract.js (configServer.js/protocol.js bara CRLF).

## 2026-10-05 förmiddag (huvudsessionen) — bänken lagad (1af893d)
Tempovarianterna körs nu på FRYST LÅTLISTA bench-manifest.txt (503 musiksnuttar, Beat This! röstat) — ny baslinje live 389/503 (Pi:ns faktiska med UP43: 388/503). Jämför inte mot /572-siffror. Bänkens "live" har nu LOTUS_TEMPO_UP43=1 (= Pi:n sedan 09-24). benchRows i daily-filen fylls igen (sämsta låtar finns där). Nästa: 5/4-fantomprov (16 låtar i kvot 1,25/0,80) som opt-in.

## Från kvällen 2026-10-05 (ÄGARENS BESLUT – ändrar uppdraget "två morgnar" ovan)
Felsökningen är AV sedan 18:0x och slås BARA på under faktisk felsökning, alltid av efteråt (`PUT /api/debug/verbose {"enabled":false}` + GET-kontroll). Den slår på Deezer-katalogen vid låtbyte (120–145 ms stall) och inlärningen. Uppdraget 10-06 (räkna '[synk] sen tick' efter första mic-start) UTGÅR — slå INTE på felsökning för det. Uppvärmningens nytta är obevisad; rapportera bara '[warmup] klar …' efter 05:00 och /api/live sync om musik spelas. FIVE4 (5/4-fantomprov) LIVE sedan 17:53 (drop-in five4.conf) – följ live-five4 och ok-andel; återgång = ta bort five4.conf.

## Morgonen 2026-10-06 — kalibrering
Ingen PUT (inga lärrader: felsökning av; ingen musik på lotus 10-05 — ingen mic-start i engine.log, FIVE4 har ingen livedata än). Uppdraget 10-06 (sena tickar efter mic-start) UTGICK enligt ägarens beslut 10-05; '[warmup] klar: 74 s ljud, 27750 hop pa 10.7 s' 05:01:29. Felsökning verifierad AV (GET {"enabled":false,"record":false}). Nattjobbet kört för hand 07:05–08:04 (Sonos IDLE). Bänk: live-five4 395/503 (= Pi:n), live utan FIVE4 388; nightly.py: 'live' inkluderar nu FIVE4 (som UP43, mätfälla 40), referensvarianten heter live-utan-five4. cd80 on-beat 0,84 = live (ej +0,03). Drift: alla 19 drop-ins = repo (md5 på innehåll), ExecStart = heap.conf, main oförändrad sedan FIVE4-deployen. Timers bara 03–05.

## Morgonen 2026-10-07 — kalibrering
Ingen PUT (inga lärrader: felsökning av, verifierad GET {"enabled":false,"record":false}). '[warmup] klar: 74 s ljud, 27750 hop pa 10.7 s' 05:00:38. Musik 10-06 14:18–14:39 + 15:24–16:22 (~78 min, första FIVE4-livemusiken, men utan lärrader ⇒ ingen ok-andel). Drops edgeAgo 10-06: n 15, median 11 ms, p75 40 ms, svans 595/2136/20592 ms (de två sista med goneSpan 2,8–19 s). Nattjobbet kört för hand 07:05–08:10 (Sonos IDLE): live(FIVE4) 395/503, live-utan-five4 388, cd80 on-beat 0,84 = live, sektioner oförändrade. Drift: 19 drop-ins = repo (md5), ExecStart = heap.conf 144/semi 4. Timers bara 03–05.

## Från kvällen 2026-10-07 (huvudsessionen, från DMX-nattagentens fynd)
Tempoökning i låten (inte låtbyte): DMX-nattagenten byggde ett syntetiskt facit (dmx-control/pi-dmx/engine/tools/tempo-facit/, 12 klipp med +8/+12/+15 % tempo vid 20 s, manifest.tsv) och mätte den DELADE analysatorn med dmx-control/pi-dmx/engine/tools/tempoShiftBench.mjs: analysatorn ser ökningen i bara 5 av 12 klipp, +8 % aldrig, och behöver ~8 s för att låsa om — under omlåsningen dippar ljuset (−0,075 medel, −0,14 p90) i stället för att accelerera. Ägaren vill att tempoökningar SYNS snyggt i showen; DMX-sidan får inte röra analysatorn. Uppdrag (steg 4c): bänka om analysatorn kan följa en tempoökning på 8–15 % snabbare än 8 s utan att tappa oktavvakten (de 21 oktavhoppsklippen i frozen6 får inte fyra) — som opt-in-flagga enligt kodregeln, med facitet ovan + korpus + syntet, paritet 0. Rapportera träff/12 och omlåsningstid före→efter.
KLART 2026-10-09: opt-in LOTUS_TEMPO_SHIFT=1 (4d9f13a, mergad + delad till DMX 13a205b, EJ deployad): träff 7→10/12, +8 % 0→3/4, omlåsning median 8,3→4,8 s, frozen6-neg 9 falska (3 oktav) oförändrat, fryst lista 395→396/503, syntet 6/8, paritet 0. Liveprov = ägarens beslut.

## Morgonen 2026-10-09 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}). 10-08-morgonen kördes inte (ingen rad/commit). Musik 10-08 ~17:55–20:17 (mic 8696 s); drops edgeAgo 10-08 n 40, median 0 ms, p75 35 ms, svans 2,1–20,6 s. Journalen har lucka 10-08 20:13 → 10-09 04:55 efter 136 000 kernelrader 'hcon sent 0 < count 2' (19:20–20:13) – timers 03:00–04:10 körde, motorstart 04:55 + reboot 05:00 (ingen kärnreboot i wtmp 04:55). Warmup 05:00:43 10,7 s. Nattjobbet för hand 07:05–08:0x (Sonos PAUSED): live(FIVE4) 395/503 oförändrat, sektioner oförändrade. Drift: 19 drop-ins = repo (md5). TEMPO_SHIFT se ovan.

## Morgonen 2026-10-11 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}). 10-10-morgonen kördes inte. Ingen musik på lotus 10-10 (ingen MOTOR_ON i engine.log.1) ⇒ SHIFT+HOLD (LIVE 10-10 22:26) har ingen livedata än. Drops edgeAgo ej mätbart (inga edgeAgo-rader i loggen). 10-09 22:14 en BLE-Down 15 s under MOTOR_ON (ingen omstart). Warmup 05:01 10,6 s. Nattjobbet för hand 07:05–08:01 (Sonos PAUSED): live (nu med SHIFT+HOLD) 396/503 (+1 = SHIFT, HOLD netto 0), syntet 6/8, on-beat 0,84, fas 219/362, sektioner oförändrade. Drift: 20 drop-ins = repo (innehålls-md5), analyser.js md5 = main. Timers bara 03–05.

## Morgonen 2026-10-12 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-11 11:46–12:11 (~25 min, första SHIFT+HOLD-livemusiken, utan lärrader). Warmup 05:01 10,7 s. Nattjobbet för hand 07:05–07:58 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 20 aktiva drop-ins = repo, analyser.js m.fl. md5 = main. DMX-fyndet buildUp (10-12) TAGET: grindarna lvlSmooth>0,3 (6 % av tiden i ladan) + novSlow>0,45 (p90 0,20) dödar signalen; ersättare (bandDb-stigning 2 s mot 8 s) AUC 0,53–0,56 mot 8 s före drops på 22 ladan-filer ⇒ ingen flagga (dmx-control 192e2e0).

## Morgonen 2026-10-13 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-12 17:15–19:08 (~113 min SHIFT+HOLD, utan lärrader). Drops edgeAgo 10-12: n 20, median ~4 ms, p75 29 ms, svans 125/5139 ms. Warmup 05:01 10,7 s. Nattjobbet för hand 07:05–08:05 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 20 aktiva drop-ins = repo (innehåll utan kommentarer), dist/audio-analyser md5 = main. Timers bara 03–05. DMX-fynd: uppvärmning TAGET (äkta artefakt 0,01→0,73 de första 13 s på klipp utan drop; förslag seed Ema=Floor=lvlSmooth + värme tills konvergerad, ej byggt), breaklängd = DMX-PROFIL (dmx-control f6f48ea).

## Morgonen 2026-10-14 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Ingen musik 10-13 (engine.log.1 bara bootrader). Warmup 05:01 10,7 s. Nattjobbet för hand 07:05–07:59 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 20 aktiva drop-ins = repo, dist/audio-analyser md5 = Pi. DMX-fynd 10-14 (intro efter låtgräns) KLART: opt-in SECTION_CARRY=N (lotus 4a008a5, DMX 983d76b), ladan 23 wav CARRY 20: intro 17→10 % av tiden, byten 3,12→3,33/min, paritet 0; ej på lotus (riktiga Sonos-låtbyten). Fynd 10-13 (tempohopp inom låt) TAGET.

## Morgonen 2026-10-15 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Ingen musik 10-14 (0 MOTOR_ON i engine.log/.1). Warmup 05:00:37 10,8 s. Nattjobbet för hand 07:05–07:55 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 20 aktiva drop-ins = repo (innehålls-md5); Pi:ns analyser.js ≠ main = SECTION_CARRY (opt-in, ej deployad, paritet 0), övriga dist/audio-analyser = main. DMX-fynd 10-15 (miniDropCount i skurar) = DMX-PROFIL: spärren MINI_SPACING_MS finns, profilen sätter '1' (dmx-control 1a30394).

## Morgonen 2026-10-16 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-15 17:23–18:50, drops edgeAgo n 87 median 0 ms. Warmup 05:01 10,7 s. Nattjobbet för hand 07:05–07:58 (Sonos PAUSED): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 20 drop-ins = repo (verksamma rader), men repots bass-body.conf (BASS_BODY=2) finns INTE på Pi:n och dist är från 10-10 ⇒ ägaren: kör bass-body-prov.py om =2 ska vara live. Inga nya DMX-fynd.

## Morgonen 2026-10-17 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Ingen musik 10-16 (engine.log.1 bara bootrader). Warmup 05:01 10,7 s. Nattjobbet för hand 11:42–13:03 (Sonos PAUSED; 81 min, längre än vanligt – parallellt med allocProf/trace-körningar): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift oförändrad mot 10-16 (bass-body.conf och bassBody.js bara i repot). DMX-fynd 10-16 (analysatorns GC-skräp) TAGET (dmx-control 8a96a27): heta funktioner stabila i TurboFan, inga explicita allokeringar i bigStep/scoreEnv/dropStep; nästa steg A/B --trace-gc.

## Morgonen 2026-10-18 — kalibrering
Ingen PUT (felsökning av, GET {"enabled":false,"record":false}; 4 lärrader ur gårdagens felsökningsfönster 12:46–12:50, spann 44,5 BPM = ett dygn ⇒ smoothS 15 orörd; oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-17 11:11–13:00, drops n 29 edgeAgo median 0 ms; sena tickar i felsökningsfönstret 4 > 50 ms, max 130 ms. Warmup 05:00 10,8 s. Nattjobbet för hand 07:05–07:56 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift oförändrad (20 drop-ins = repo; bass-body.conf + skräpjaktens dist bara i repot). DMX-fynd 10-18 TAGET (dmx-control 760723a): computeBpm 0 % TurboFan på Node 18 = 17 kB bytekod (18 tickar, nollas vid IC-byte); --bytecode-size-allowance-per-tick=20000 ⇒ 43 %. Fynd 10-17 tempovandring i break TAGET (idé HOLD vid basen borta).

## Morgonen 2026-10-23 — kalibrering
Ingen PUT (felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-22 (PAUSED 13:07/14:12/17:28 UTC), drops n 154 edgeAgo median 0 ms (p75 11). Nattjobbet för hand 07:04–08:00 (Sonos PAUSED): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362 — första bänken på flaggstädad kod (3d992a2), oförändrad; evidence 385→383, ring10 308→311 (deras borttagna flaggor). Drift: drop-ins Pi = repo utom bass-body.conf (känt); Pi:ns dist äldre än main (flaggstädningen ej deployad, ägarens beslut). DMX-fynd 10-22 SECTION_EARLY-medianen AVVISAT (opt-in EARLY_OWN byggd, 25 lang hiStart 38→27 %, koden bort); onset.kick-klampningen TAGET.

## Morgonen 2026-10-24 — kalibrering
Ingen PUT (inga lärrader: felsökning av; kalibreringen orörd). Ingen musik 10-23. Nattjobbet för hand 10:26–11:22 (Sonos PAUSED): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift = i går (bass-body.conf bara i repot, dist äldre än main enl. ägarens beslut). Inga nya DMX-fynd.

## Morgonen 2026-10-25 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-24 10:40–19:09 (MOTOR_ON ×4), drops n 353 edgeAgo median 0 ms (p75 29), en BLE-Down 15 s 17:31 (restart-log ble-down-light-frozen). Warmup 04:00Z 10,8 s. Nattjobbet för hand 07:05–08:13 (Sonos PAUSED): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift = i går (drop-ins lika i verksamma rader, bass-body.conf bara i repot, dist äldre än main enl. ägarens beslut). Timers 03:00–04:10 (sommartid slut i natt). Inga nya DMX-fynd.

## Morgonen 2026-10-26 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Ingen musik 10-25 (engine.log.1 bara bootrader, 0 drops). Warmup 04:01Z 10,9 s. Nattjobbet för hand 07:05–08:06 (Sonos IDLE): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. Drift: 21 aktiva drop-ins md5 = repo, bass-body.conf bara i repot, dist äldre än main enl. ägarens beslut. Timers 03:00–04:30. Inga nya DMX-fynd.

## Morgonen 2026-10-27 — kalibrering
Ingen PUT (inga lärrader: felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Musik 10-26 15:27–19:03, drops n 209 edgeAgo median 0 ms (p75 27). Warmup 04:00Z 10,7 s. Nattjobbet för hand 07:05–~08:10 (Sonos PAUSED): live 396/503, syntet 6/8, on-beat 0,84, fas 219/362, sektioner = i går. FAST_BANDS se kvällsuppdraget ovan. Drift: 21 aktiva drop-ins md5 = repo, bass-body.conf bara i repot, dist äldre än main (ägarens beslut), ExecStart 144/semi 4. Timers 03:00–04:10. DMX-fynd 10-27 (gallop/onset.kick +130 ms) TAGET (dmx-control 4d71f26).

## Morgonen 2026-10-28 — kalibrering
Ingen PUT (felsökning av, GET {"enabled":false,"record":false}; smoothS 15, oktavregel false, lead 72/rise 36, chainLatency 30, energyGridTrust 99 orörda). Körningen startade sent (18:15). Ingen musik 10-28 före 18:15; engine.log.1 utan drop-rader. Warmup 04:00Z 10,9 s. Nattjobbet för hand 18:16–19:39 (Sonos IDLE): live 396/503, syntet 6/8, kick r 0,80/p 0,86, on-beat 0,84, fas median 0,89 (n 362), sektioner = i går. piHealth i dygnsposten saknas: PC:n bytte nät (10.100.x) ca 19:39, Pi:n onåbar därifrån (inte nere enligt 18:15-kontrollen). Drift: 21 aktiva drop-ins lika i verksamma rader, bass-body.conf bara i repot. Timers 03:00–04:10.
