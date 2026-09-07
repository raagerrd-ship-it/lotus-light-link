# ANDRA PASS (opt/förenkla) — Agent 2: analyser.ts (ALLT mirror-bound → pi-dmx master först)

## 1 · optimize · MED — Band-härledd efterbehandling körs 375 Hz på data som bara ändras 125 Hz
- profile :1390-1409, riser/novelty :1365-1388, drop :1262-1362, hat/snare peak-hold :1253-54, spec/onset/
  specAbs frame-writes :1412-17 — ALLA körs varje hop (375Hz) UTANFÖR `if(++bigCounter>=BIG_EVERY)`-blocket.
- Men de läser bandLvl[]/bandOn[]/bandAbs[] som bara räknas om i big-FFT-blocket (:1198-1245, var 3:e hop=125Hz).
  Mellan big-hops är arrayerna KONSTANTA → all aritmetik re-härleder samma resultat 2 hops av 3. Profile har
  8-sek-EMA tickad 375×/s; ~100+ flops/hop som är 3× redundant. Största per-hop-poolen utanför FFT:erna.
- Fix (output-neutral): flytta profile+riser (+ spec/onset/specAbs-writes) IN i bigCounter-blocket, byt EMA-alfor
  dtHop→bigDt (som aBandLvl :824 redan gör). EMA av konstant-hållen input konvergerar identiskt. Confidence hög.
- ⚠️ drop-blocket (:1262-1362) större pris men RISKIGT: bodyGoneMs+=dtHop, 0.5s bodyHist-ring, mätta trösklar
  (2000ms/0.15) trimmade live @375Hz → kan flyttas men re-validera mot drop-bench först.

## 2 · optimize · LOW-MED — Två fulla pass över 2048-FFT-spektrat kan fusioneras till ett
- :1187-90 (magnitude sqrt för i 0..magBigMax≈684) sen :1198-1245 (band-loop läser magBig[i]/prevMagBig[i] per
  band). Banden kontig (bandLo[b+1]===bandHi[b] :804-805) → bins 1..683 besöks en gång tvärs 8 band, men de två
  passen går samma ~684 bins TVÅ ggr var 3:e hop. Fix: beräkna magBig[i]=sqrt inline i band-loopen; hantera bin
  0+683 med 2 explicita sqrt; flytta specSink(:1195) efter fuserade loopen. Låg-med risk (specSink-ordning delikat).

## 3 · optimize · LOW-MED — Big-FFT-bufferten slidar 2048 sampel VARJE hop men läses var 3:e
- :1172-73 bufferBig.copyWithin(0,hop)+set() varje hop (375Hz), skiftar ~1920 elem (~720K elem-copies/s), men
  bufferBig läses bara av FFT i BIG_EVERY-blocket. Fix: stega inkommande hops i en 384-buffer (0-alloc), gör EN
  copyWithin+set i bigCounter-blocket → memmove 375→125/s (~3× cache-tryck-lättnad). 512-bufferten måste fortf.
  slida varje hop (RMS). Behaviour-neutral. Kommentaren :1171 ("matas VARJE hop") ska uppdateras.

## 4 · simplify · MED (låg CPU) — BPM-lås har TRE parallella "challenger"-mekanismer i disjunkta regimer
- octave-vote :582-87, neighbor nearChallenger/nearVote :588-617, song-change challengerBpm/newSongVote/
  lastSongVoteMs :644-683 + bpmStable/lockPeak. 9+ state-vars. neighbor(!committed) och song(committedNow) är
  strukturellt nästan identiska challenger-trackers, ömsesidigt uteslutande (bpmStable>=60), skiljer bara på
  grind + tröskel-enhet. Unifiera nearChallenger+challengerBpm→en, nearVote+newSongVote→en ackumulator,
  parametriserad på regim → ~halverar lås-state. ⚠️ HÖG beteende-risk (trösklar mätta mot äkta ljud) — gör med
  offline-bench (setVirtualClock finns :754-58). Deliberat refaktor, ej drive-by. (Första pass-buggen var just
  en divergens mellan två vägar som borde matcha.)

## 5 · simplify · LOW — Tre överlappande tempo-reset-fältlistor driver isär
- silence-reset :1037 (~18 fält inline), resetTempo :702-708, hintTrackChange :720-729. Gemensam kärna
  (bpmHistLen/Pos, octaveVote, nearVote, nearChallenger, bpmStable, newSongVote, challengerBpm, lastSongVoteMs,
  lockPeak) dubblerad 3×. Fix: privat clearLockVotes() från alla tre (var + regim-extras). Exakt formen som gav
  pass-1-reacq-buggen. Noll CPU.

## 6 · optimize · LOW — AGC-gain-smoothing kör Math.exp per hop trots bara 2 möjliga tau
- :961-62 tau = tauUp*2 el tauDown*0.25 (konstanter), ga=1-exp(-dt/tau) varje hop mic-läge (375/s). Överlever för
  dt är wall-clock-variabel. Marginellt, mic-only. Bara om AGC-blocket ändå rörs: precompute aGainUp/Down för
  fast-dt, fall back till exp vid avvikelse. Låg prio.

**Net:** #1-3 är CPU-relevanta + oberoende (redundant per-hop-block ×3, redundant spektrum-pass, ~3× big-buffer-
memmove). Var för sig inkrementella (tiotals µs/hop mot 2.67ms-budget) men staplar, låg risk (utom drop-delen av
#1). #4-6 = maintainability. ALLT mirror-bound.
