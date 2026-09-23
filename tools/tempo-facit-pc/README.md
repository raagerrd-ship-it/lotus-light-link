# tempo-facit-pc — facit ur ljudet (2026-09-19)

PC:n **hämtar** 30 s-snuttar (48 kHz mono, samma ljud som analysatorn får) från Pi:n, räknar tempo i
efterhand och skriver facit tillbaka i Pi:ns katalogcache. Inga portar öppnas, ingen PC-adress på Pi:n.

- Pi: vid låtbyte +10 s fångar motorn 30 s (`startRawCapture(30, titel, fullRate=true)`) till
  `<PCC_DATA_DIR>/snippets/`, kö max 30. Routes: `GET /api/tempo/snippets`, `GET /api/tempo/snippet?key=`,
  `PUT /api/tempo/facit`, `GET /api/tempo/cache`. Snutten raderas när facit kommit.
- PC: `tempo_facit.py [http://192.168.1.174:3051] [--once]` pollar var 20 s. Autostart: `tempo_facit.bat`
  via Startup-mappen (`LotusTempoFacit.cmd`). Logg: `tempo_facit.log`. Venv: `.venv` (librosa 1.0, numba).

**Tempot väljs på evidens, inte på trackerns prior.** Klicktest (kick 80 Hz + hi-hat): librosas
`beat_track` med default-prior gav 168 → 112,5 (2/3), 86 → 114,8 (4/3), 172 → 114,8 (2/3) och la slagen
på hi-hatsen vid 123 — samma fällor som förra sessionens egna autokorrelationer. Därför: tempogrammets
topp-6 kandidater, varje kandidat pinnas (`bpm=`), slagen läggs ut, **bas-onset (< 220 Hz) mäts på slagen**
— fantomer träffar kickarna bara varannan/var tredje gång och förlorar. Oktav ×2 avgörs av halvslagstestet i
basbandet (halvkvot ≥ 0,6, tak 200). Resultat på syntetiskt test: 6/6 (92, 123, 168, 86 m. 16-delar, 172,
110 m. kick varannan). Allt (kandidater med slagpoäng, halvkvot, conf) följer med i cacheraden så reglerna
kan granskas mot analysatorn. Analysatorn är gemensam med pi-dmx: det som bevisas här ska in i analysatorn.

## Minikorpus ur ladans inspelningar (`mkcorpus_mix.py`, 2026-09-21)

Korpusen `corpus/` (facit-tjänstens snuttar från Pi:n) raderades 21 sep och bänken stod med bara syntet. `mkcorpus_mix.py`
bygger ett **komplement** ur ladans egna inspelningar (`pi-dmx/engine/tools/`: `pop_ladan.wav` + `megamix_ladan.wav`, 48 kHz
mono, 600 s var — strömmade WAV:ar med `dataLen 0` i huvudet, läses med egen tolerant läsare — samt de fem korta filerna
`stranden/drickervin/tspel/utandig/real` hela, 45–60 s). Inga Pi-anrop, inget moln: **facit = Beat This!** (lokal ML-slagföljare,
`.venv-ml`, ny `--batch`-läge i `beatthis_facit.py` så modellen laddas en gång), inte PC-facit ur molnet.

Regler per 30 s-fönster (hopp 30 s): (1) ingen låtgräns i fönstret — nyhetsdetektor på klangen (MFCC 2–20 standardiserade,
medel 4 s före mot 4 s efter, toppar ≥ median + 4·MAD, ≥ 15 s isär; `MIX_NOV_K` ändrar) OCH Beat This!-slagen passar ett stelt
grid (residual ≤ 45 ms, tempohopp ≤ 5 % mellan tredjedelarna); (2) kvalitetsgrinden (brus) + RMS ≥ 0,01; (3) två röster överens:
Beat This! mot PC:ns stela librosa-grid (`estimate_rigid`, produktionens PC-facit) inom 4 % (`facitVotes: 'bt+pc'`) eller i
oktavförhållande (`'bt~pc-oktav'`, `voteClass: 'oktav'`). Bänken viker facit till [80,160) så oktaven kvittar där.
Ut: `corpus-mix/<id>.wav` (48 kHz mono 16-bit) + `<id>.json` i bänkens schema (`result.bpm/beatsS/quality/analysis.onset.timesS`,
`beatthis`, `row {artist:'ladan', title:'pop_ladan@600s'}`, `kind:'mix'`) + `_summary.json` med varje fönsters dom (även de
bortfallna, med Beat This!-mått så nyhetsdetektorn kan dömas mot slagen). Katalogen är data (gitignorerad) och ligger i huvudrepot.

    .venv\Scripts\python.exe mkcorpus_mix.py [--out DIR] [--src DIR] [--dry] [--limit N]
    node bench.mjs --dir <absolut sökväg till corpus-mix> [--synth corpus-synth]

**Första bygget 2026-09-21 (938 s, varav Beat This! 875 s på 45 fönster):** 45 fönster in → **21 ut**. Bortfall: 18 låtgräns
enligt klangen (10 i pop, 8 i megamix), 5 där Beat This!-slagen inte passar ett stelt grid (residual 75–708 ms: pop@0, megamix@0
och @150-trakten, `tspel` 75 ms, `real` 708 ms — kort, ojämnt material), 1 oense (megamix@150: BT 93,5 mot PC 62,2). Röster på de
22 dömda: lika 13, oktav 8 (megamix 85,8/171,6, 93,5/187, 130/65; `utandig` 90/180), oense 1 — Beat This! och det stela gridet
är alltså överens om slagperioden i 21/22, oktaven spretar i 8. Materialet är smalt: pop@240–540 är en sammanhängande sträcka
126→130 BPM (troligen 2–3 beatmatchade låtar som klangdetektorn inte skiljer), megamix 93,5 ×3 och 130 ×3 är samma låtar — räkna
med ~8 distinkta låtar, inte 21. Bänkens baslinje (`node bench.mjs --dir corpus-mix --synth corpus-synth`, 46 s):

| variant | korpus-mix rätt | klasser | syntet |
|---|---|---|---|
| standard | 14/21 | lika 14, 3/2 3, annat 4 | 6/8 |
| live (nattjobbets LIVE + BENCH_GRID) | **17/21** | lika 17, annat 4 | 6/8 |
| evidence | 16/21 | lika 16, annat 2, 4/3 2, 2/3 1 | 6/8 |
| ring10 | 14/21 | lika 14, 3/2 2, annat 4, 4/3 1 | 6/8 |

Live: kick-recall 0,85/precision 0,69, on-beat-recall 0,88, gridfas mot Beat This! i fas 9/18, motfas 1, median 0,83. Standardens
tre 3/2-fel är alla megamixens 130-låtar (analysatorn väljer 86–90); `pop_ladan@240s` (140 mot 126) och `utandig` (99/144 mot 90)
faller i alla varianter. Facit-svagheter: Beat This! lästes inte mot katalog eller öra, oktaven är modellens val, och 30 s-fönster
med hopp 30 s ger få låtar per mix — kör med `MIX_KEEP_STEADY=1` för att behålla gränsfönster där slagen ändå är stadiga.

## Mer än tempo (2026-09-19, "kör och bygg allt")

Pi:n loggar under fångstfönstret (`<id>.events.json`): kick-ringen, gridpulsernas fyrtider (`getRecentPulses`),
ljusstyrkan 10 Hz (= `lastSent.pct`) och drop/riser-flaggorna, allt i väggklocka; `captureStartWallMs` =
WAV:ens sample 0. Två slag av fångst: `tempo` (10 s in, 30 s) och `drop` (15 s förbuffert @48 kHz +
15 s efter; utlöses av analysatorns `dropCount` eller `POST /api/tempo/capture {kind:'drop'}`, max 2/låt).

PC:n räknar per snutt och skriver in i cacheraden (`pc`, dropdomar i `dropEvents`):
- **phase**: kick/puls-offset mot PC:ns slag (bara on-beat, |off| < slag/4; negativt = före). `pulse.medianMs`
  är FYRTIDEN; lampan lyser ~lead + BLE-latens senare. Första mätningen ("Move On"): kick −10 ms (rätt),
  puls −69 ms mot lead 132 ⇒ gridet ~60 ms sent — samma släp som mättes för hand 09-18, nu automatiskt.
- **level**: ljus mot RMS (dB, 5–95 %-normerat), korskorrelation lag −0,5..+1,5 s → `lagMs`, `r`. OBS (09-23): `r` mäter
  tak × taktpuls mot RMS i 100 ms-raster — pulsen (moddjup ~0,4, fyrad före slaget) är brus där och sätter ett tak på r ≈ 0,75–0,8
  även med perfekt tak; motorns värde 0,3–0,4 säger därför mest om pulsdjupet. TAKMÅTT (`FACIT_LEVEL_EXT=1`, standard):
  `ceilR`/`ceilLagMs` = bright och dB genom samma EMA 400 ms (pulsen borta, lagen lika på båda sidor), lag −0,5..+2,5 s;
  `pulseShare` = variansandel som EMA:n tar bort; `pctPerDb` = lutning %/dB (10 dB-fönster över 82 % ⇒ 8,2 ideal);
  `clipShare`/`floorShare` = andel av p90-taket (2 slag) ≥ 0,98 / ≤ 0,25 (fönstret ligger fel = ankare/gain). Nattjobbet
  medianar `levelCeilR`, `levelCeilLagMs`, `levelPctPerDb`, `levelClipShare` i dygnsposten.
- **onset**: PC:ns basonsets (< 220 Hz) mot kick-ringen → precision/recall/bias. Första: p 0,75–0,9, r 0,39.
- **drop**: svacka (bas ≤ 50 % i 3,5 s) → återkomst (≥ 60 % inom 2 s), `score`; för drop-fångster dom
  `ratt/falsk/osaker` mot händelsen vid 15 s; `realtimeDropsAtS` = detektorns egna fyrningar i fönstret.
- **descr**: spektral tyngdpunkt, basandel, perkussivitet (HPSS), dynamik dB, basonsets/s.

## Rapport (`report.py`)

`report.py --n 10 --findings findings.json --out rapport.html` hämtar `GET /api/tempo/cache`, tar de N senaste
låtarna med PC-analys och skriver en artifact-sida (nyckeltal, punktdiagram puls/kick mot slaget med lead-linjen,
tabeller för tempo/fas/nivå/onset/drops/deskriptorer) + JSON. Fynd och nästa steg ges i `findings.json`.
**2026-09-19, tio country-låtar** (`findings-2026-09-19.json`): analysatorn hade rätt tempo i 3 av 10 (3/2 ×2,
4/3 ×2, halva ×1, annat ×2); analysatorns spann inom låt 50 BPM i median; gridet +13 ms median när tempot är rätt
(IQR 22–52 ms); kick-bias −9 ms; onset precision 0,8 / recall 0,5; styrkekanalen lag 250 ms, r 0,4; inga drops i
materialet; ringens oktavregel 1/2 → avstängd (`beatOctaveRule` false). Mätfälla rättad samma dag: pulsoffset
måste mätas mot förväntad fyrtid (slag − lead), annars klipper on-beat-fönstret bort just −lead-regionen.

## Körbänk för analysatorns tempoval (`bench.mjs`, 2026-09-19)

`node bench.mjs` matar den kompilerade analysatorn (samma kod som Pi:n) hop för hop med `corpus/` (PC-facit)
och `corpus-synth/` (känt tempo, `gen_synth.py`), driver analysatorns **virtuella klocka** från ljudet
(`setVirtualClock`) och klassar median-bpm över de sista 20 s mot facit. **Läxa:** utan virtuell klocka går
30 s ljud på 1 s väggtid och all tidsstyrd logik (röster var 250 ms, commit) bryts — första baslinjen (0–2/8)
var ett harnessfel, inte analysatorn. Med rätt klocka: gamla vägen syntet 6/8 (2 = avsedd oktavvikning),
korpus 3/7. Provat och FÖRKASTAT (opt-in-flaggor kvar i `analyser.ts`): `LOTUS_TEMPO_EVIDENCE=1` (tempogrammet
som kandidatgenerator + slagpoäng på basonseten: syntet 6/8, korpus 1/6 — verkliga baslinjer har toner på
många delslag), `LOTUS_TEMPO_EVIDLOCK=1` (evidensmedian som lås: 4/8, 1/6 — grannkandidater poängsätts lika,
medianen hoppar), `LOTUS_TEMPO_ENV_S=8|10` (längre onset-ring: 1/7, 3/7 — inget). Debug per fil:
`BENCH_DEBUG=<namn> node bench.mjs` (kandidater, poäng, lås per 5 s). Korpusen växer med en låt per spelad låt.

## Löpande drift i två lager (2026-09-19, "ja")

**Lager 1 — nattjobb utan LLM.** Facit-tjänsten (`tempo_facit.py`, kör alltid, autostart via Startup-mappen) kör
`nightly.py` en gång per dygn efter 04:30: körbänken över `standard/evidence/evidlock/ring10` mot korpus + syntet,
dygnsstatistik ur Pi:ns cache (domar, ok-andel av dömda, gridsläp, kick-bias, onset, nivå, spann, ledtrådar,
drops) → `scoreboard.jsonl`, `scoreboard.md` (senaste 14 dygn, spårad i git), `daily/<datum>.json`. Idempotent per dygn;
`--force` kör om. Första raden 2026-09-19: standard 3/14 korpus · 6/8 syntet, ok-andel 0,47, gridsläp +4,5 ms.

**Lager 2 — morgonagenten.** Schemalagd Claude-uppgift `lotus-morgonagent` (07:06 dagligen, kör bara när
Claude-appen är öppen; annars vid nästa start). Läser resultattavlan + cache, kontrollerar hälsa, gör säkra
kalibreringsjusteringar med gränser (beatLeadMs ±20/dygn inom 80–200 efter gridsläp på ≥ 8 ok-låtar; beatTempoSmoothS
8–20; beatOctaveRule bara vid ≥ 80 % på ≥ 5), provar en analysatorvariant via drop-in `tempo-variant.conf` BARA
om den slår standard med ≥ 3 låtar på ≥ 36 korpuslåtar utan syntetförlust (återgång vid > 15 procentenheters fall
i ok-andel), publicerar morgonrapport-artifact (`morning-artifact.txt` håller URL:en), skriver minne, committar.
Rör aldrig useRecording/useMetaTempo/integratorn/drops/BLE. Pi:ns `analyser.js` deployades 2026-09-19 17:10 som
beteendeidentiskt bygge (backup `analyser.js.bak-20260919-1710` = 09-04-filen) så varianterna kan växlas med flaggor.

## Regression 2026-09-19 17:10–21:20: `onsetEnhancements` (LÄXA)

Deployen av HEAD-bygget av `analyser.js` var INTE beteendeidentisk med Pi:ns 09-04-fil: 09-07-mergen
(commits daterade 08-31) införde `onsetEnhancements` (per-bin-whitening + variansnormering av onset-kurvan)
som 09-04-bygget tyst ignorerade medan `alsaMic` skickade `true`. Från 17:10 kördes DSP:n skarpt: live ok-andel
50 % → 16 %, avvisat 22 % → 51 %; körbänk på samma 64 låtar: gamla bygget 30/64, nya med flaggan AV 30/64
(identiskt), nya med flaggan PÅ 12/64. Åtgärd 21:20: `alsaMic` skickar `onsetEnhancements: process.env.LOTUS_ONSET_ENH === '1'`
(standard av), körbänkens standard likaså (`BENCH_ENH=1` slår på). **Regel för morgonagenten:** `LOTUS_ONSET_ENH`
får bara slås på efter körbänksvinst enligt variantregeln (≥ +3 låtar på ≥ 36, ingen syntetförlust). **Metodregel:**
"beteendeidentiskt" ska bevisas med körbänken mot den fil som faktiskt kör på Pi:n (hämta den, `pi/dist/audio-analyser-old/`),
inte antas ur git-diffen mot HEAD.

## Liveprov 2 — kickdetektorn (2026-09-20 10:23, "börja bygg")

Rätt mått för kickdetektorn är **on-beat-recall** (andel PC-slag i valt tempo, `beatsS`, som fick en analysatorkick
inom ±60 ms) — inte recall mot alla bastoner (`timesS`, PC:n räknar varje baston). Bänken kördes som live
(`BENCH_GRID=1`, evidence + ring10) på 107 låtar, tempot orört i alla varianter:

| variant | kick-recall | precision | on-beat-recall |
|---|---|---|---|
| baslinje (grind på, cooldown 170) | 0,48 | 0,84 | 0,63 |
| grind av | 0,52 | 0,85 | 0,68 |
| grind av + cooldown 120 | 0,70 | 0,84 | 0,89 |
| **grind av + cooldown 100 (LIVE)** | 0,82 | 0,84 | 0,95 |
| grind av + cooldown 80 | 0,89 | 0,83 | 0,96 |

Orsak: en baston strax före slaget skuggade slagets kick i 170 ms, och grinden mot analysatorns eget grid förkastade
slagets kick när gridet låg fel. Tröskelfaktorn K (3,0–3,5) gav inget. Deploy: nytt `analyser.js` (rattarna
`LOTUS_KICK_NOGATE`, `LOTUS_KICK_COOLDOWN`, `LOTUS_KICK_K`, `LOTUS_KICK_EFLOOR`; standard identisk) med backup
`analyser.js.bak-20260920-1016`, drop-in `tempo-variant.conf` fick de två KICK-raderna, en omstart. Första livelåten
(Dua Lipa/Blexxter, 128): onset p 0,93 r 0,92 (samma förmiddag före: r 0,40–0,59). Nattjobbet bänkar nu `live`,
`live-cd80`, `live-cd120` med kickmått i tavlan; kickvarianter döms på on-beat-recall utan precisionsförlust > 0,02.
Full bänk på live-konfigurationen 10:35 (110 låtar): tempo 62/110, kick 0,82/0,84, on-beat 0,95, syntet 6/8 — en
körning tar 64 s, nattjobbets sju varianter ≈ 8 min. Motorns PLL ignorerar kickar med |fel| ≥ 0,25 slag, så de extra
kickarna (2 → 4,5 per slag) når fasregleringen bara nära gridet; gridkvaliteten döms live på `pc.phase.pulse.onBeat`,
`offBeatShare` och `iqrMs` över minst 8 låtar.
Live 10:23–10:45, 6 låtar mot 118 låtar dygnet före: onset recall 0,94 mot 0,39, precision 0,83 = 0,83; pulsernas
on-beat 29,5 mot 26,0, offBeatShare 0,49 mot 0,50, iqr 85 = 85 ms — kickdetektorn bättre, gridkvaliteten oförändrad
(gridLag-medianen per låt spretar mer, −20…+85 ms, men n = 6; morgonagentens leadregel kräver ≥ 8 ok-låtar).

**Läxa 13 (deploy av `dist/audio-analyser/`):** bygget importerar syskonmoduler (`tempoTracker.js` sedan 09-20).
Att bara kopiera `analyser.js` gav `ERR_MODULE_NOT_FOUND` och 69 kraschomstarter på 7 minuter (status 1 direkt,
felet syns bara i `/var/log/pi-control-center/apps/lotus-light/engine.log`, inte i journalen). Deploya hela katalogen
(`pi/scripts/deploy-analyser-dir.py`: md5-diff, `node --check`, importtest på Pi:n, backup, EN omstart) och verifiera
med `systemctl is-active` + API:t, inte med att filen ligger där.

## Facit mot katalogen: analysatorn slår PC-facit — ledtrådarna parkerade (2026-09-20 11:40)

`catalog_backfill.py` slår upp Deezer-tempo för korpusen (46/138 träffar, sparas i `corpus/<id>.json` under `catalog`) som
OBEROENDE referens (Pi:ns cache skriver över katalogvärdet med PC-facit). Mot de 46: **PC-facit rätt 31/46, analysatorn
32/42** — och räknar man analysatorns 4 "halva" som vikningen (facit 162–178 ≥ 160 → lampan pulserar på halva takten med
avsikt) är analysatorn rätt 84 %. Där PC och analysator skiljer sig med fantomklass (3/2, 4/3, 2/3, 3/4) hade analysatorn
rätt 5/5 (Carlene Carter, Lotta Engberg, Drängarna ×2, E-Type); PC:ns två oktavfel (Fröken kärlek 165 mot 83, Tell Me Why
161 mot 80) kom direkt ur trackern med hög conf. **Slutsats:** en tempoledtråd ur PC-facit drar gridet fel nästa spelning i
~15 % av låtarna → `tempoHint`/`octaveHint` (skapande + tillämpning) är parkerade i `pi/src/index.ts` bakom
`LOTUS_TEMPO_HINTS=1` (deployad 11:37, backup `index.js.bak-20260920-1137`; domar och lärdata sparas som förr). Bänken viker
nu facit till analysatorns [80,160) (7 "dubbla" var bara vikningen). Provat: täckning (recall) i evidensvalet
(`FACIT_REC_EXP=1`) blev SÄMRE (62 → 51 lika analysatorn) — librosas beat_track snappar slagen mot onseten även vid pinnat
fel tempo, så fel kandidater får hög precision och täckning. Nästa prov: stelt grid med finsökt period (`FACIT_METHOD=rigid`,
`refacit.py` + `compare.py` mot katalog och analysator). Regel: facit får bara styra ledtrådar när det bevisligen slår
analysatorn mot katalogen.

## Stelt grid = facit i produktion (2026-09-20 12:05) + fasfyndet

`FACIT_METHOD=rigid` (standard nu): period finsökt ±4 % kring tempogrammets kandidater (+ oktavpartner), fas i 32 steg,
poäng = medel av basonset på slagen (max ±2 ramar)/p95, ingen täckning (`FACIT_RIG_REC_EXP=0`; täckning 1 gav 27/46).
Mot Deezer-katalogen **37/46** (gamla evidensvalet 31/46, analysatorn 32/46), lika analysatorn 83/110 → korpusen omräknad
(`refacit.py --write`, `prevBpm` kvar) och bänken mot det nya facit: **analysatorn 116/144 rätt tempo (81 %)**, klasser
annat 14, 4/3 5, 3/4 4, 2/3 3. Kvar hos rigid: tre 160–178-låtar väljs på halva (oktavvalet) — ofarligt för lampan (vikningen).
`compare.py gammalt rigid0` visar raderna; `catalog_backfill.py` ger katalogreferensen; `allin1_facit.py` kör Replicates
all-in-one-modell (ML-slagföljare, ~27 GPU-s ≈ 1–2 cent per låt) som tredje, oberoende referens — körs för hand, en gång per låt.

**Fasfyndet (offline ur korpusens händelseloggar, 39 låtar där gridet = facit i samma oktav):** motorns pulser i fas (≥ 80 %
inom ±¼ slag) i bara 5 låtar, i MOTFAS (≤ 20 %) i 9 (Geo Da Silva ×3, Kaylee Bell, Dolly Style, Grönwalls, Smokie …), resten
däremellan (drift/omankring). Helbandsonseten är starkare på PC-fasen än på halvslagsfasen i alla grupper (kvot 0,60 i
motfasgruppen) ⇒ PC-fasen är slaget och lampan pulserar på off-beaten där. Orsak (kod): motorns PLL initieras på en kick
och släpper bara in kickar inom ±¼ slag — hamnar gridet på off-beat-basen (åttondelsbas) bekräftar den sig själv för alltid.
Bänkens nya `fas`-kolumn mäter analysatorns `beatAnchorMs` — men den är BARA senaste kicken (analyser.ts 1751), så 0,98 där
säger bara att kickarna träffar slagen. Nästa steg: en riktig gridfas i analysatorn (alignScore-fas på basringen + halvslagstest
mot helbandet) som motorn följer, mätbar i bänken mot PC-slagen.

## Tre röster + ML-fas (2026-09-20 12:40) och liveprov 3: gridfasen

**Beat This!** (ISMIR 2024, `beatthis_facit.py`, egen miljö `.venv-ml` med torch cpu; 5–10 s per snutt på i5-6200U) ger slag
och nedslag lokalt. Korpus (160 låtar): tempo lika Beat This! ↔ all-in-one 53/56, lika katalogen 41/46 (all-in-one 20/21,
PC-facit 41/46); **fas** Beat This! ↔ all-in-one i fas 32/50, motfas 1 — men PC-facit ↔ Beat This! motfas 19/87.
PC-fasen (medel basonset) är alltså opålitlig, ML-följarna är överens. `compare_refs.py` visar allt.

**Facit-tjänsten** (omstartad 12:41): tempot i majoritet av PC-facit och Beat This! (`facitVotes` pc+bt); är de oense
avgör molnet (all-in-one, `FACIT_CLOUD_TIEBREAK=1`, tak `FACIT_CLOUD_MAX`=40/dygn) — håller molnet med ingen blir bpm 0 =
osäkert facit, som Pi:n aldrig dömer på. **Fasreferensen** (`beatsS`: pulsfas, onset, bänkens on-beat) är Beat This!-slagen
som stelt grid (`beatsSource: 'beatthis'`); 20 ms-kvantiseringen tas bort med linjär anpassning.

**Liveprov 3 (12:42, drop-in `tempo-variant.conf` + `LOTUS_GRID_PHASE=1` + `LOTUS_PHASE_FOLLOW=1`).** Motorns pulser mot
Beat This! på korpusens händelseloggar (77 låtar, samma oktav): i fas 17, motfas 12, mellan 48, median 0,49, puls-IQR 80 ms —
kick-PLL:en håller inte fasen. Analysatorns gridfas i bänken mot Beat This!: i fas 93/127, motfas 3, mellan 31 (median 0,95).
Därför följer motorn nu gridfasen (kick-PLL av). Mått live: `pc.phase.pulse.onBeat/offBeatShare/iqrMs` mot Beat This!-slag
— målet är on-beat-andel ≥ 0,8 på de flesta låtar. Återgång: ta bort de två raderna, daemon-reload, restart. Korpusen visade
också att "motfas 9/39" i förmiddagens mätning till stor del var PC-fasens fel (Geo Da Silva ligger i fas mot Beat This!: 0,99).

Variant `LOTUS_GRID_PHASE_MODE=bass` (basringen först, helbandet bara när basen är tvetydig, kvot < 1,2): mot Beat This! i fas
96/127, motfas 2, median 1,00 (summan: 93/127, 3, 0,95); mot all-in-one 45/62 mot 35/50. Marginellt bättre (Tequila/hardstyle:
helbandet röstade på off-beat-leaden), inom bruset — kvar som opt-in, byts inte mitt i liveprov 3.

**Slutsiffror referenser (13:40, all-in-one klar 145/162, `compare_refs.py`):** tempo Beat This! ↔ all-in-one 115/123, PC ↔
all-in-one 117/123, alla tre lika 110/123; mot katalogen all-in-one 37/40, PC 41/46, Beat This! 41/46. Fas: Beat This! ↔
all-in-one i fas 77/111, motfas 1; PC ↔ all-in-one motfas 12/68. Bänk, analysatorns gridfas: mot all-in-one i fas 80/107,
motfas 4; mot Beat This! 93/127, motfas 3. Bugg 13:31 rättad: `import allin1_facit` körde korpusloopen (5 molnanalyser,
315 s per låt) — nu under `__main__`; fasanalysen använder slagens eget tempo även vid osäkert facit (bpm 0).

## Sektioner i realtid (2026-09-20 13:55, opt-in `LOTUS_SECTION=1`, delad analysator → DMX)

Slutläget är att båda Pi-systemen kör allt i realtid, så sektionsdetektorn använder bara låtens egen historik: `intensity`
(nivå relativt låtens robusta baslinje) + `buildUp`/`breaking`/drop + 1 s-blockstatistik → tier (låg/mellan/hög, 3 s hysteres)
och trend (8 s) → `frame.section` = intro | low | build | high | break, `sectionAgeMs`, `sectionIndex` (refräng nr),
`sectionTier`. Upprepning: klangavtryck var 4:e s (8 band normerade + centroid + kicktäthet + intensitet, L2) mot alla avtryck
≥ 16 s tillbaka (max 96) → `repeatSim`, `repeatAgoMs`, `repeatSection` (≥ 0,92 mot 'high' = refrängen är tillbaka; tröskeln är
konsumentens). Bänk på snuttarna (sanity, inget facit): 157/167 låtar når 'high', median 4 byten per 30 s, intro→build→high→break
ser rätt ut; upprepningsräknaren är för generös på 30 s (6–10 träffar) → tröskel/features trimmas mot helåtsfacit.
Facit kräver hela låtar (all-in-one på 30 s-snuttar ger bara 'intro'): långfångster till datorn under inlärningen, aldrig i drift.

Provat och förkastat 14:40: `LOTUS_EVID_BAND=both` (helbandsringen vägs in i kandidatvalet, för material utan kick): vikt 0,5
129/175, vikt 1,0 131/178 med en syntetförlust (3/2), baslinjen bas 131/178. Helbandet tillför inget och kostar en alignScore
till per kandidat — kvar som opt-in. Filmmusikens tempofel (4/3, 3/2 på Two Steps from Hell, Trevor Jones) är alltså inte
bandvalet; nästa spår är att titta på kandidatgenereringen (tempogrammets toppar saknar ofta rätt period helt på orkestralt).

## Lokalt sektionsfacit utan moln (`section_facit_local.py`, 2026-09-22 natt)

Molnets sektionsfacit (all-in-one via Replicate, tak 40/dygn, kostar) föll bort när korpusen raderades 09-21. Ersättare för
gränserna: `section_facit_local.py` — librosa-segmentering (MFCC + chroma_cqt + log-RMS + basonset, slagsynkade på Beat This!-
slagen ur json:en eller librosa beat_track med tidsvarierande tempo; Foote-novelty på självlikhetsmatrisen, kärnor 8+16 slag,
finlokalisering med 4-slagskärna, snappning till taktstreck, segment ≥ 8 s). Tier (high/mid/low/intro) räknas med **samma**
`derive()` som molnfacitet (`section_facit.py`, nu importbar), så definitionen är identisk. Skrivs som
`result.analysis.sections.derived_local` (+ `local` med metod/validering) och — när molnets `derived` saknas — även som
`derived` med `source:'local'`/`derivedSource:'local'`, som bänken läser. Molnet ersätter det lokala när det senare levererar.
Nattjobbet (`nightly.py` → `sections_step()`) kör molnets derive och därefter lokalt facit på fångster ≥ 60 s utan derived,
före bänken; `LOTUS_SECTION_FACIT_LOCAL=0` stänger av, `LOTUS_SECTION_FACIT_LOCAL_MIN_S`, `LOTUS_SECTION_MIN_SEG_S`,
`LOTUS_SECTION_KERNEL=8,16` är rattar. Fristående: `section_facit_local.py --wav a.wav b.wav --out <katalog>`;
`--compare` = lokalt mot molnet där båda finns. Körtid ≈ 5 s per 3 min låt (10 min mix 17–32 s, validering lika mycket till).

Validering utan facit (sparas i `sections.local.validation`): **stabilitet** (gränser återfunna inom ±1 s vid 0,5 s-förskjuten
start) 0,82–0,85 på 10-min-mixarna, 0,7–1,0 på 180 s-utdrag, tier-lika 0,7–0,8; **rimlighet** 10 segment/3 min, median 14–15 s,
high-andel 0,36 (definition). **Fraskonsistens** (gräns inom ±1 slag från 4/8-taktsmultipel, tidsbaserat mot lokal slagperiod)
är däremot nära slumpen (0,1–0,3, slump 0,19) även med Beat This!-nedslag på 4 × 180 s-utdrag (ett undantag 0,6): novelty-
topparna är inte fraskvantiserade — snappning till 4/8-taktsraster skulle göra måttet trivialt och är därför inte gjord.
**Mot molnet** på de två långfångster som hann få molnsegment (Colt 45, Sounds Like Something I'd Do): gränsrecall 0,4–0,5 och
precision 0,25–0,43 (±3 s), high==high per sekund 0,56–0,72 — lokalen delar finare (8–9 segment mot molnets 6–7). Kärna/min-
segment-rutnät på n=2 gav inget entydigt (recall 0,28–0,45), standard behållen. Kända skillnader mot molnet: fler och kortare
segment, gränser ±1 takt, inga etiketter (label 'seg'), 30 s-snuttar ger bara 2–3 segment.

## Liveprov 3 fortsatt: fasföljaren mätt live (15:00–16:00) — MÄTFÄLLA 15 och PI-reglering

`LOTUS_PHASE_TRACE=1` (tillfällig 4 Hz-spårlogg i motorn, `[fasspar]`) visade att bänkens följar-emulering INTE ser
live-problemen: (1) motorns grid (12 s-median) låg kvar på förra låtens tempo i sekunder vid låtbyten → fasfel
meningslöst → 903 flippar/2 h; (2) estimatet bytte halvslag var ~20 s på vissa låtar. Fix (bf3355e): följ bara när
analysatorns bpm = gridets ±4 %, flip kräver kvot ≥ 2,0 i 4 raka, klistrig fas i analysatorn (byte bara när ny fas ≥ 1,25× förra
i 6 raka analyser). Flippar 903/2 h → 19/15 min.
Offline-dom (`result.beatsS` = tjänstens valda referens, rena snuttar, grid = facit ±4 %): kick-PLL 0,46 (n=55, motfas 8),
följare v1 0,49 (n=10), v2 0,49 (n=7, motfas 0, IQR 91 ms). Alltså baslinjen, inte bättre — felet är **konstanta offsetar**
50–100 ms per låt (Status del två +96 ms med IQR 15 ms): gridets tempo släpar 1–2 % efter analysatorns → följaren jagar med
konstant släp. Bänken (analysatorn ensam): fasmätningens offset median +20 ms, |offset| 25 ms, 56 % inom 30 ms → estimatet
duger, motorn är felet. 15:55 (287bf01): PI-reglering (bpm följer fasdriften, klamp ±4 %), bias 20 ms, kP 0,4/0,2. Döms med
samma offline-mått (phase_verdict-logiken) på nästa låtar; mål |offset| ≤ 30 ms och on-beat ≥ 0,8 på de flesta.
**Beat This! på svensk partypop:** fel tempo i 4/10 (184 mot 102, 120 mot 138) — trerösten höll (molnet avgjorde), men
fasreferensen faller då tillbaka på PC-slag. Kvalitetsgrinden (brus) fångade 14:13–14:36.
