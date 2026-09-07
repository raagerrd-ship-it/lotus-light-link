# ANDRA PASS (opt/förenkla) — Agent 1: piEngine.ts

**Ram:** efter pass 1 (grid-scratch borta, FRAME_MS, död kod purgad) är 75Hz-het-pathen redan tight — ingen
mätbar CPU kvar (allt nedan = ensiffriga µs/s på A53). Rankat på KLARHET + latent-bugg. F1 = äkta korrekthets-fara.

## F1 · simplify · MED — Defaults på TVÅ ställen som är OENSE (korrekthetsfara)
- DEFAULT_CAL (175-201) vs inline `cal.X ?? default` i het-pathen. loadCalibration returnerar alltid
  `{...DEFAULT_CAL, ...parsed}` (238) så alla nycklar finns — men het-pathen har egna inline-fallbacks som KROCKAR:
  - `lowSoftFloor`: DEFAULT_CAL=**0.3** (186) men tickInner läser `?? 0.25` (1498).
  - `transientGain`: DEFAULT_CAL=**0.4** (185) men computeTickConstants `?? 1.0` (106); interface-doc (128) säger också "1.0". TRE källor, tre svar.
  - `brightnessFloor`: DEFAULT_CAL=25 (181), läst `?? 0` (105) — ofarligt nu men samma mönster.
  - +~10 döda `?? default`/tick: tickEnergyFloor(1461), peakBoost(1448), onsetEnergyFloor(1090), colorSpectralTilt(1598), beatLeadMs(1114), barAccent(1121), beatSyncStrength(683), dropFlashMs(795).
- Döda i normalfallet (spread garanterar närvaro) MEN inte döda om en sparad profil bär explicit `null` för en
  nyckel → inline-fallbacken fyrar och applicerar TYST ett annat värde än DEFAULT_CAL (0.25 ist f 0.3). Äkta
  two-source-of-truth-fara. CPU försumbar; payload = korrekthet/klarhet.
- Fix: gör DEFAULT_CAL enda källan. Släng inline `?? literal` (lita på spread) ELLER normaliseringspass i
  loadCalibration som strippar null/undefined före spread. Ev. optimering ovanpå: hoista config-skalärerna
  (peakBoost, lowSoftFloor, tickEnergyFloor, colorSpectralTilt, barAccent, beatLeadMs, dropFlashMs) in i
  TickConstants så het-pathen läser rena tal. ⚠️ BETEENDE: vilket default som "vinner" (0.3 vs 0.25, 0.4 vs
  1.0) är en känsla-ändring → kräver mänskligt beslut, inte blind merge. Confidence hög.

## F2 · simplify · MED-LOW — Diagnostik-only-matte + 5 döda tc-fält (fortf. live i v766)
- (1) Bevisat identiska/output-döda: `loudness`(1480)=`ampEnv<=0?0:ampEnv>=1?1:ampEnv` men ampEnv är EMA av
  level∈[0,1] → loudness≡ampEnv ALLTID (clampen biter aldrig). `ceiling`(1481) läses BARA av _diag.ceiling
  (1637), matar ingen output (brightness = outN). `bassNorm`/`midHiNorm`(1455-56) + `energyNorm`(1522) = rena
  alias, bara _diag (1632-33,1640).
- (2) Döda precomputade konstanter: tc.attackAlpha(96), releaseAlpha(97), onsetDecay(99), onsetRiseAlpha(100),
  dimmingGamma(104) beräknas vid varje cal/tickMs-ändring men läses ALDRIG (tickInner räknar om attack/release
  från cal.* via _eRatio 1488/1495; onset använder bara …Fft 591/593/595). dimmingGamma drar in död import
  getDimmingGamma(21). Värre: döda tc.attack/releaseAlpha beräknas med ratio=tickMs/125 (66) = FEL takt → om
  någon kopplar in dem blir de subtilt fel.
- Fix: tilldela _diag.* direkt från källuttrycken (eller släng fälten om UI ej visar dem); använd ampEnv ist f
  loudness. Radera de 5 olästa tc-fälten + getDimmingGamma-importen. (Pass 1 flaggade detta LOW men det var EJ
  i "redan fixat" — fortf. live. Nu med bevis loudness≡ampEnv.) Confidence hög, noll beteende.

## F3 · optimize · LOW — refractoryFrames räknas om varje frame (579)
`Math.max(1, Math.round(cal.onsetRefractoryMs / FRAME_MS))` 75×/s, beror bara på config+konstant. Fold in i F1:s
tc-hoist (tc.refractoryFrames i computeTickConstants). Noll beteende.

## F4 · simplify · LOW — Heartbeat-release 2×log+1×exp där 1×pow räcker (1490-93)
`exp(log(_c)+alpha*(log(_t)-log(_c)))` = `_c * (_t/_c)^alpha` → `_c * Math.pow(_t/_c, alpha)`. Samma resultat,
färre transcendentaler, läses som geometrisk interpolation. (Env-EMA:ns 2×exp 1471-72 + attack/release pow lämnas
— memoisering ej värd komplexiteten vid denna CPU.) Verifiera _lo-clampen skyddar _t/_c mot 0 (gör det, floor 1e-4).

## F5 · simplify · LOW — updateBeatClock kallar Date.now() 5 extra ggr (redan har nowMs)
nowMs @631, sen färska Date.now() @639,643,644,688(×2); onFluxReady @1089,1114. Upp till 6 Date.now()/beat-clock
(75×/s). Återanvänd nowMs (639/643/644/688) — enklare + MER korrekt (undviker µs-skilda tidsstämplar i en fas).
Behåll kickAt/getLatestFrameAt (egna källklockor).

## F6 · simplify · LOW — Redundanta clamp-lager + fade-tween som aldrig vilar
- 3 sekventiella clamps (1516-28): energyForm→[0,1] (1516-17), outN re-clamp [floorN,1] (1519-20 DÖD by
  construction), pct re-clamp [floor,100] (1527-28 DÖD). Defensiva (NaN fångas redan 1432).
- Fade (1568-82): k≈elapsed/3000≈0.004 → tar aldrig snap-grenen, kör no-op `c+=(t-c)*0.004` för evigt efter
  konvergens. "3000ms" är en TIDSKONSTANT (~63% vid 3000ms), inte klar-tid — kommentaren antyder annat.
- Fix (lågt värde, bara om man ändå är i regionen): en final clamp på pct; "fade active"-flagga som rensas vid
  |c−t|<0.5 för att hoppa tween-blocket i vila.

**Skippat som brus:** N≈13 insertion-sort-median (543-55, ~7µs/s — inkrementell = buggyta för intet); setAnalyser-
BeatGrid ref-store (676); _diag ~24 fält-skrivningar (~1ns). Den enda impactful hot-path-vinsten (per-frame alloc)
togs redan i pass 1.
