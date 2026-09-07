# RAW FINDINGS — Agent 1: piEngine.ts (dirigent)

**ARCHITECTURAL FACT (verified):** onFFTReady/onFluxReady (→ tickInner, processOnset, updateBeatClock, processDrop) fire from emitBands, which runs every BAND_EVERY_HOPS=5 analyser hops of 128 samples @ 48kHz = **75 Hz, NOT 100 Hz** the comments assume. (alsaMic.ts:433-434,889-908). Cross-confirms alsaMic agent.

## MED memory — Per-frame heap alloc: setAnalyserBeatGrid grid object
- piEngine.ts:658 (also re-anchor alloc :633). updateBeatClock runs ~75Hz, unconditionally setAnalyserBeatGrid(this._beat ? {bpm,anchorMs} : null). Whenever a beat exists (most of a song) allocates fresh {bpm,anchorMs} ~75×/s. analyser.setBeatGrid just stores ref (analyser.ts:768), only read.
- ONLY per-frame heap alloc left in file's hot path. Swap disabled → young-gen churn drives GC pauses ("motorn droppar"). ~4500 obj/min avoidable.
- Fix: private _gridScratch={bpm:0,anchorMs:0}, mutate + pass, else null. Single-thread JS safe. Optionally mutate this._beat in place at :633.
- Confidence high, no behavior change.

## MED smarter — Onset/drop time constants calibrated for 100Hz but frames ~75Hz (~33% stretch)
- computeTickConstants fftMs=10 at :66 (feeds onsetDecayFft/onsetRiseAlphaFft :96-97); refractory Math.round(onsetRefractoryMs/10) :566; processDrop frame windows :719-735 (FAST/SLOW_ALPHA, MIN_BREAKDOWN_FRAMES=40, REFRACTORY_FRAMES=400).
- Real period 1000/75≈13.33ms not 10ms. So onset decays ~33% slower wall-clock; refractory 110ms→~147ms; drop fast EMA 150ms→208ms; slow 2.5s→3.3s; breakdown 400ms→533ms; drop refractory 4s→5.3s. Comments inconsistent (:1136 "93/sec (48000/512)"; others 100Hz).
- Fix: shared FRAME_MS=1000/75 (or derive from ANALYSER_HOP/SAMPLE_RATE/BAND_EVERY_HOPS exported from alsaMic); drive fftMs, refractory divisor, drop *_FRAMES/alpha from it; re-check defaults.
- Confidence high on rate; medium it matters perceptually — some defaults may've been tuned by ear at wrong rate → correcting shifts behavior, do WITH a re-tune.

## MED robustness — Onset median window sized from tickMs but fed at band-emit rate → wrong duration + swings with decoupled knob
- piEngine.ts:498 onsetSize=max(3,((175/tickMs+0.5)|0)). processOnset called ~75Hz independent of tickMs. Buffer len=round(175/tickMs) treats period as tickMs. Default tickMs=25 → size7 → 7×13.33≈93ms (175 clearly meant 175ms). Worse: window scales with tickMs which no longer affects tick rate: tickMs=10→18fr≈240ms, tickMs=50→4fr≈53ms → changing tickMs silently reshapes onset sensitivity.
- Adaptive threshold (med*onsetThreshold) depends on window; half-length → noisier median + couples beat detection to unrelated setting.
- Fix: onsetSize=max(3,round(175/FRAME_MS))≈13 at 75Hz, independent of tickMs. Remove tickMs from initOnsetBuffer sig.

## MED simplify — Drop "express" BLE write immediately superseded by tickInner same synchronous cycle — redundant
- piEngine.ts:776-783 express sendToBLE(r,g,b,100) in processDrop (from onFluxReady alsaMic.ts:433). But emitBands calls _onFluxReady then _onFFTReady back-to-back sync (alsaMic.ts:433-434); _onFFTReady→tickInner sees dropFlash active (:1551), writes pct=100 again µs later. 1-slot freshest-wins → express overwritten before delivery. Both under identical guards (playing && _bleOwner==='active') → always co-fire. Express sends raw pre-LUT this.color; tickInner sends CALIBRATED color.
- Fix: delete express sendToBLE :778-782; rely on tickInner dropFlash path (forces pct=100, bypasses deadband). Keep dropFlashUntil/dropCount bookkeeping.
- Confidence med-high.

## LOW simplify — Dead precomputed TickConstants fields (recomputed on cal/tickMs change, never read)
- piEngine.ts:91-99 attackAlpha, releaseAlpha, onsetDecay, onsetRiseAlpha, dimmingGamma. tc.attackAlpha/releaseAlpha never read (tickInner recomputes from cal.* :1453,1460); tc.onsetDecay/onsetRiseAlpha never read (only …Fft :578-582); tc.dimmingGamma assigned from getDimmingGamma() never read → import+call dead too.
- Fix: drop 5 unused fields from interface+computeTickConstants; remove unused getDimmingGamma import.

## LOW simplify — Dead engine state + stale header docstring from removed tick-gate
- _nextTickDeadline (:1145, written :1156,1166, never read), _lastTickTime (:1141, written :1157,1165, never read), lastBrightness (:361, only reset/NaN-guard :927,984,1215, never read — note calls it "kvar men oanvänd"); header :3-14 & :1136 describe tickMs-gating + "100Hz/93sec FFT" that don't match (onFFTFrame :1147 has no tickMs gate — runs every frame).
- Fix: delete 3 dead fields; update header — ticks run once per band-emit frame, tickMs only paces BLE delivery (slot lease :450).

## LOW simplify — Hot-path computations feeding only diagnostics
- bassNorm/midHiNorm (:1420-1421, used only :1596-1597 no-op clamp, already amp×share∈[0,1]); ceiling (:1446, only :1601); loudness clamp (:1445) — ampEnv already [0,1] so loudness===ampEnv always. Per 75Hz tick, dead-for-output math in hottest fn.
- Fix: assign _diag.* directly from source exprs; use ampEnv directly. NOTE: energyForm×loudness multiply at :1482 = the "redundant loudness multiply" the pending input-sync change targets.

## LOW simplify — Dead config knob cal.bassWeight (type :117-118, default :172 bassWeight:0.9; no read in piEngine). Onset source now bands.bassFlux. Mark deprecated / DROPPED_CAL_KEYS; keep in type for saved-profile compat.

## LOW robustness — Drop EMAs not covered by NaN sanitizer; two different "energy" gates
- sanitizeState (:1211-1217) omits bassFast/bassSlow; onset energy gate uses peakBand=max(bassRms,midHiRms) (:1070-1073) while tickInner silence gate uses totalRms (:1426-1427). If bands.bassRms non-finite, processDrop EMAs (:726-728) latch NaN permanently (bassSlow<=0 reseed false for NaN), never recover. Onset vs silence gate use different energy defs; onset-energy-gate note documents totalRms.
- Fix: add Number.isFinite resets for bassFast/bassSlow to sanitizeState. Decide if both gates key off totalRms; align comment/note.

**Note (not code):** stale .lovable/memory notes vs committed code — onset-express-path.md describes processOnset express write that no longer exists (express only in processDrop); onset-energy-gate.md shows totalRms where code uses peakBand; anti-flicker-pipeline.md deadband (0.5+pct/100) differs from code (1.6-1.4*pct/100, :1511).
