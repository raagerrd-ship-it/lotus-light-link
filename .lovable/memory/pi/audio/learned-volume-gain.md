---
name: Lärd volym→gain-AGC (FIX 4)
description: alsaMic lär per Sonos-volym ett p90-ref av rå block-RMS (tvåstegs: 4s-fönster → 180s EMA), gain = lgTarget/ref. Persisteras i mic-state.json. Tvåpunktskurvan är cold-start-prior.
type: feature
---
**Varför inte den förbjudna AGC:n:** den anpassar sig mot SONOS-VOLYMEN, inte mot ljudnivån. Vers→refräng vid samma volym rör inte gainen (inom-låt-variation 0,7 %); volymbyte ger direkt ny gain (feed-forward).

**Implementation (`pi/src/alsaMic.ts`):**
- `learnGainSample(blockRms, dt)` anropas per audio-block direkt efter `lightRawRms`-EMA:n.
- Steg 1: p90 över ett ~`lgWinSec` 4 s ring-fönster (transient-tåligt). Steg 2: `ref[vol] += (measured - ref) * dt/lgRefTauSec` (180 s) → rör sig i minuter.
- `learnedGainFor(vol)`: exakt lärt → log-interpolerade lärda grannar → `null` (då används tvåpunkts-`interpolateGain` som prior).
- `recomputeAutoGain` föredrar lärt värde; `refreshAutoGain()` körs 1 Hz från `index.ts` så gainen följer det förfinade ref:et utan volymbyte.
- Gates: `setGainLearnGate(playing, tvMode)` från `applySonosStateToEngine` (lär aldrig i TV-läge), tystnadsgolv 0.0015, 3 s frys efter volymbyte (ring töms), volym > 0.
- Persistens: `learnedGainRefs` i `mic-state.json`, debounced 30 s.
- Params: `setLearnedGainParams({enabled,target,winSec,refTauSec})` — `enabled:false` = exakt gamla beteendet (riskfri rollback). Default `lgTarget 0.6`.

**Parat med:** `DEFAULT_CAL.adaptiveCeiling = false` i `piEngine.ts` — med konsistent lärd gain är det jagande taket överflödigt och orsakade "släpet".
