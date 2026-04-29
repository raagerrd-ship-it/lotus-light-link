## Sub-frame onset express + adaptive release + relaxed slot-lease

Three coordinated latency improvements in `pi/src/piEngine.ts` + telemetry additions in `pi/src/ble/state.ts`. Builds on the just-landed ACL-outstanding gate (live read of `noble._aclConnections` + `ACL_MAX_OUTSTANDING=6`), which is already deployed.

Goal: kick-to-light drops from ~25–50 ms (avg ~32) to ~13–20 ms (avg ~17) on percussive content.

### 1. Express onset path (`processOnset`, ~line 436)

Right after `this.onsetTarget = 0.45; this.onsetLastFrameIdx = …`, fire a sub-frame BLE write that bypasses the tick gate:

- Guard on `this._bleOwner === 'active'` and `this.lastSentPct >= 0` (ensures `_finalColor` is initialized by a prior `tickInner`).
- Compute `boostPct = (0.45 * (cal.transientGain ?? 1.0) * 100) | 0`, then `expressPct = min(100, lastSentPct + boostPct)`.
- Call `sendToBLE(_finalColor[0..2], expressPct)` — reuses module-scoped `_finalColor`.
- On `'sent'`: update `this.lastSentPct = expressPct` (so next `tickInner` deadband doesn't suppress the natural down-stroke), bump `bleStats.onsetExpressCount`.
- On `'busy'`: bump `bleStats.onsetExpressBusyCount`.
- Do NOT touch `this.smoothed` — `tickInner` remains authoritative for the EMA tail.
- Refractory gate above already bounds rate to ≤1 express write per detected onset.

Note: `_finalColor` is module-scoped (line 226) — accessible inside the class method.

### 2. Adaptive release alpha (`tickInner`, line 1012)

Replace the constant-alpha branch:

```ts
let alpha;
if (energyNorm > this.smoothed) {
  alpha = tc.attackAlpha;
} else {
  const drop = this.smoothed - energyNorm;
  const threshold = this.cal.releaseDropThreshold ?? 0.05;
  const boostFactor = this.cal.releaseDropBoost ?? 0.6;
  const boost = drop > threshold ? drop * boostFactor : 0;
  alpha = Math.min(0.85, tc.releaseAlpha + boost);
}
this.smoothed = this.smoothed + alpha * (energyNorm - this.smoothed);
```

- Track `bleStats.adaptiveReleaseAlphaMax` high-water for sanity (expect 0.15–0.85).
- Add optional `releaseDropBoost` (default 0.6) and `releaseDropThreshold` (default 0.05) to the calibration type — soft-fallback so existing saved profiles work without migration.

### 3. Relaxed slot-lease (constructor + `setTickMs`, lines 351 + 364)

Change both call sites from:
```ts
setSlotLeaseMs(tickMs);
```
to:
```ts
setSlotLeaseMs(Math.max(5, (tickMs / 3) | 0));
```

At `tickMs=20` that gives a ~7 ms lease — leaves room for one `tickInner` write + one express write per tick window without exceeding `ACL_MAX_OUTSTANDING=6`. Floor of 5 ms protects the controller. `protocol.ts` lease implementation needs no change.

### 4. Telemetry (`pi/src/ble/state.ts` — `bleStats`)

Add four counters to the existing `bleStats` object so they auto-surface in `/api/status`:

```ts
onsetExpressCount: 0,
onsetExpressBusyCount: 0,
adaptiveReleaseAlphaMax: 0,
slotLeaseMs: 0,           // mirror of last setSlotLeaseMs() value
```

Update `slotLeaseMs` from inside `setSlotLeaseMs` in `protocol.ts` (one line) so the live effective lease is visible without poking the engine.

### 5. Memory note

Add `mem://pi/audio/onset-express-path.md` documenting the express-write contract, dependency on the ACL gate, and the lease/3 invariant. Add to `mem://index.md` Memories list.

### Out of scope

- HCI buffer probe, explicit outstanding reset, 250 ms watchdog (already decided SKIP).
- `colorFadeMs` linearization, multi-palette, HSV/Lab fades, ALSA period sizing.

### Verification (post-deploy, in `/api/status`)

1. `onsetExpressCount` grows during drum passages (~1.5–4/s during active drumming).
2. `onsetExpressBusyCount / onsetExpressCount` < 5%.
3. `controllerOutstandingCount` peaks 3–4, never reaches 7.
4. `controllerStuckCount` and `writeFailCount` stay at 0.
5. `writeLatMaxMs` may rise from ~5 → ~10 ms; should not exceed 30 ms (else back lease floor off to `tickMs/2`).
6. `outstandingMaxObserved` (already shipped) shouldn't reach `ACL_MAX_OUTSTANDING=6`.
7. Visual: kicks "land" with the beat instead of trailing it.

### Files touched

- `pi/src/piEngine.ts` — express path in `processOnset`, adaptive alpha in `tickInner`, lease formula in constructor + `setTickMs`, optional cal fields.
- `pi/src/ble/protocol.ts` — mirror lease into `bleStats.slotLeaseMs` inside `setSlotLeaseMs`.
- `pi/src/ble/state.ts` — four new stats fields + bump build tag to `2026-04-29/onset-express`.
- `.lovable/memory/pi/audio/onset-express-path.md` (new), `.lovable/memory/index.md` (one-line addition).
