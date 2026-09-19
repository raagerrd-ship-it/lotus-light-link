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

## Mer än tempo (2026-09-19, "kör och bygg allt")

Pi:n loggar under fångstfönstret (`<id>.events.json`): kick-ringen, gridpulsernas fyrtider (`getRecentPulses`),
ljusstyrkan 10 Hz (= `lastSent.pct`) och drop/riser-flaggorna, allt i väggklocka; `captureStartWallMs` =
WAV:ens sample 0. Två slag av fångst: `tempo` (10 s in, 30 s) och `drop` (15 s förbuffert @48 kHz +
15 s efter; utlöses av analysatorns `dropCount` eller `POST /api/tempo/capture {kind:'drop'}`, max 2/låt).

PC:n räknar per snutt och skriver in i cacheraden (`pc`, dropdomar i `dropEvents`):
- **phase**: kick/puls-offset mot PC:ns slag (bara on-beat, |off| < slag/4; negativt = före). `pulse.medianMs`
  är FYRTIDEN; lampan lyser ~lead + BLE-latens senare. Första mätningen ("Move On"): kick −10 ms (rätt),
  puls −69 ms mot lead 132 ⇒ gridet ~60 ms sent — samma släp som mättes för hand 09-18, nu automatiskt.
- **level**: ljus mot RMS (dB, 5–95 %-normerat), korskorrelation lag −0,5..+1,5 s → `lagMs`, `r`.
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
