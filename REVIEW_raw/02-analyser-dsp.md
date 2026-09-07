# RAW FINDINGS — Agent 2: analyser.ts / beatClock.ts (DSP)

**Rate architecture (verified):** analyser fed by dedicated 128-sample/375Hz tap, sampleRate 48000. 512-pt FFT @ 375Hz + decimated 2048-pt every 3rd hop (BIG_EVERY=3, ~125Hz). emitBands every 5 hops = 75Hz (the dirigent rate).

## HIGH robustness — Re-acquisition window NEVER closes → BPM lock permanently loosened after first track change
- analyser.ts:721 (set), :604 (compare), :543+:756 (clock), comment :197-198
- hintTrackChange() sets reacqUntilMs = Date.now()+windowMs (epoch wall-clock ~1.75e12). Gate consuming it: `const reacq = voteNow < this.reacqUntilMs` uses voteNow=perfNow()=virtualMs??performance.now() — monotonic-since-start ~10^6-10^7. So voteNow<reacqUntilMs ALWAYS true once hintTrackChange fired once (would take ~55000yr for performance.now() to catch up). Reset to Date.now()+5000 each hint but never falls below voteNow.
- hintAnalyserTrackChange(5000) is LIVE — called every Sonos track change (piEngine.ts:610). While reacq true, neighbor-correction confidence gate drops 0.75→0.55 + vote requirement 8→3 (:605,:610). So after FIRST song change of a session, BPM lock permanently held in loose "re-acquiring" mode: easier to yank onto 10-20% neighbor tempo + ambiguous audio rest of night. Same clock-domain class as the kick-grid-gate bug already fixed (warning :1004-1007).
- Fix: set deadline in same clock as compare: `this.reacqUntilMs = this.perfNow() + windowMs;` + update "Väggklocka" comment :197. Deterministic-clock-safe (works live + offline/virtual; wallNow()-fix would break virtual clock).
- Confidence HIGH (clocks differ ~12 orders of magnitude; field comment says wall clock but compare uses perf clock). Minimal low-risk fix restores intended 5s window.
- ⚠️ This is the ONE analyser finding worth pushing through the mirror workflow promptly (live correctness bug).

## MED robustness/smarter — hintTrackChange keeps stale tempogram, working against its own purpose
- analyser.ts:720-727 vs resetTempo :702-708. resetTempo does tempoGram.fill(0); soft hintTrackChange does NOT. tempoGram = EMA lag curve computeBpm picks bestLag from (:462-467). After change to different tempo, previous song's evidence stays + must decay at a=0.15 (:459) while new builds.
- Purpose of hintTrackChange is FASTER re-lock (~2-3s). Retaining old peak biases toward old tempo, slows re-lock exactly on large-tempo-jump case. (Effect currently masked by #1.)
- Fix: decay not preserve — `for(...) tempoGram[i]*=0.3` rather than full clear, keep localBpm as start guess. Do #1 FIRST then re-measure.

## LOW-MED perf — Full bass-envelope BPM scoring computed then discarded when bass weak
- analyser.ts:450-453 (+scoreEnv :366-436). scoreEnv(envBassRing) runs full autocorr+comb+pulse-train xcorr+prior (~half computeBpm cost) BEFORE wBass known. When eBass≤eFull*0.15, wBass=0, scoreBass ×0 at :463 → whole bass compute wasted.
- computeBpm heaviest arithmetic after FFTs, up to 100Hz during first-lock/re-acq. Energy to decide wBass is cheap O(N) first loop; only expensive lag loops need gating.
- Fix: split scoreEnv into cheap energy pass + expensive scoring; compute both energies first, decide wBass, run expensive scoring only for contributing band(s), full band scored LAST (off-beat test + parabolic interp read envPosScratch/acScratch :363-365,:469). Modest win in bar use (bass-heavy dance keeps wBass=0.55). Mirror-constrained.

## LOW simplify/memory — Dead per-hop compute: frame.drum + peak-hold envelopes no consumer in Lotus
- analyser.ts:1251-1259 (hatHit/snareHit/kickHit), output :1416-1417. grep: nothing reads frame.drum. 3 peak-hold envelopes computed every hop (375Hz) for unused field. (frame.onset/specAbs ARE used by emitBands alsaMic.ts:372-373; kick/kickAtMs/barShift/bpm/intensity/dropCount by engine; profile/inZone/breaking/level/gain feed /api/status.) Mirror-constrained (DMX master uses drum) — flag upstream or leave.

## LOW simplify — lastRiserMs written never read (declared :265, written :1383). Vestige of disabled riser-gated drop. Remove (mirror-only).
## LOW simplify — bandLvl verbatim copy of bandLvlSm (:161-162, copy :1222-1223). Collapse to one array (mirror-only).
## LOW robustness — Rolling sumSq guard catches drift not NaN
- :847-858 guard `if(++rmsRecalc>=400 || ss<0)` :854. ss<0 forces recompute vs cancellation, but NaN sample → ss NaN, NaN<0 false → guard skips → NaN sticks in rolling sum until sample slides out + periodic (≤400-hop ~1s) recalc; self-heals but briefly poisons rms→level→gain. Fix: `|| !(ss>=0)` (catches NaN+neg, one token). Defensive (ALSA int→float rarely NaN). Mirror-constrained.

## CORRECT/INTENTIONAL — do NOT change
- FFT sizing sane + measured for Zero2W: 512-pt@375Hz + decimated 2048-pt every 3rd hop, measured 2.67ms/hop budget. big-FFT mag loop capped at magBigMax (~bin684) not 1024, saves ~340 sqrt/big-FFT.
- Hot path genuinely 0-ALLOC. process()+computeBpm() allocate nothing per frame — scratch/rings/views preallocated + pointer-swapped. Bounded (ENV_LEN=500, bpmHist=20, bodyHist=200, agcBlocks=16). No leak.
- Micro-opts correct: precomputed EMA alphas (:817-828), perceptual-prior LUT (:236-243), rolling RMS+periodic recompute, power-weighted centroid single sqrt+1.47 cal, adaptive computeBpm stride (100→20Hz unlocked, 4Hz locked), octave-fold MAX=2×MIN invariant avoids oscillation.
- AGC↔detection SOUND. AGC gain touches only energy (fixed-threshold gate) + level (fixed [0,1]); onset/BPM run on raw flux with self-scaling median+MAD / normalized-autocorr thresholds → gain-invariant. Div-by-zero + NaN-from-parabola guarded (combMax/pulseMax=1e-9, den<0 strict, powSum>1e-12, envelope>1e-4). beatClock.ts clean pure math, correct negative-modulo.

## ⚠️ MIRROR CONSTRAINT (applies to findings 2-7)
analyser.ts/beatClock.ts are a READ-ONLY MIRROR of pi-dmx/engine/src/analyser.ts (header :4-9, note analyser-sync.md). Fixes must land in the DMX master FIRST then copy down with hash bumped. Finding #1 is the exception worth pushing promptly (live correctness bug). Unused mirror API in Lotus (not bugs): resetTempo(), resetBar(), setVirtualClock() — no Lotus callers (only hintTrackChange + resetGain wired).
