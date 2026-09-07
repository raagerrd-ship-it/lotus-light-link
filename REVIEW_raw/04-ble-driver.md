# RAW FINDINGS — Agent 4: ble-driver/ + ble/

## HIGH robustness — Outer scan timeout races slow-but-successful connect → false-negative feeds process.exit watchdog
- connect.ts:317 timeoutMs=6000, timer :529, vs inner withTimeout: connectAsync 4000 (:401), GATT 8000 (:435), anchor 3000 (:453); failure accounting :577-591.
- Outer timer cleared only in finish(), which for success runs AFTER GATT+anchor. GATT timeout 8000>6000, connectAsync(4s)+GATT can exceed 6s on weak/contended link. Outer timer fires mid-GATT → finish({connected:false}) (matched=true branch) → connectHardcoded returns FAILURE → _consecutiveFailures++. Then onDiscover continues, setDevice/attachControllerDrain/_onConnected/finish({connected:true}) (no-op) run — lamp ACTUALLY connected. Success reset of _consecutiveFailures (:564) never runs (r.connected false).
- Zero2W/shared radio: GATT slowness = exactly what WiFi+BLE contention + RSSI<-75 produce (~750ms/retransmit). Race structurally reachable under target conditions. Confusing "failed" logs, wasted reconnect, transient state inconsistency, and repeated false-negatives → CONSECUTIVE_FAIL_LIMIT=4 process.exit — CAN CAUSE the watchdog hard-restart it's meant to avoid.
- Fix: clearTimeout(timer) at top of onDiscover once matched=true; let inner withTimeouts bound connect phase. Outer timer then only bounds scan-to-match; budgets no longer overlap.
- Confidence high race exists (8000>6000 unconditional); self-heal (next attempt idempotent-true resets counter) makes full exit less likely than false log, but inconsistent-state window + wasted cycles certain.

## HIGH smarter/perf — Conn interval forced to 15ms, contradicting documented 20ms shared-radio fix
- forceConnInterval.ts:45-46 defaults min/max=12, :109 targetUnits=12, :148 re-assert 12,12. Stale comment connect.ts:479 says "FORCE 7.5ms".
- All paths apply 12 units=15ms. But file header (:19-27) + mem force-conninterval-hcitool/connection-optimization mandate 16 units=20ms, chosen because 7.5ms caused ~22h hang on Zero2W shared BCM43436; 20ms halves BT event rate (~50 vs ~133/s). 15ms=~66/s — back toward the pressure the fix removed.
- Single biggest lever on BLE radio load; code silently drifted below hard-won value while comments claim 20ms. Re-introduces IRQ pressure on shared chip — suspected root of long-uptime hangs.
- Fix: set targetUnits + defaults to 16 (20ms) to match header+note, OR if 15ms deliberate re-tune, update header+note+stale 7.5ms comment. Don't leave code+rationale disagreeing.
- Confidence high on divergence; intentionality unknown — reconcile, don't blind-bump.
- ⚠️ SYNTHESIS TENSION: our own session lotus-ble-latency memory set conn_min=6/conn_max=12 (7.5-15ms) FOR LATENCY (made it "feel in sync"). Repo note says 20ms FOR STABILITY (anti-hang). Real latency-vs-stability tradeoff on this knob — must decide/document.

## MED robustness — 1-slot decouples the await, but noble's SYNCHRONOUS write still on audio loop = residual freeze path
- protocol.ts:323-340 (_syncT0/writeSyncMaxMs/writeSyncSlowCount around writeAsync(buf,true) in drainQueuedWrite), armed via armDrain→setTimeout from sendToBLE (:483).
- sendToBLE correctly sync/non-blocking (enqueue+armDrain) — tick never awaits BLE, contract sound. BUT writeAsync runs in setTimeout on SAME libuv loop as audio tick. noble does ACL/HCI socket write synchronously before returning promise; if native call blocks (kernel HCI backpressure while WiFi hogs radio) it starves tick → mic frames back up in ALSA → ~8s freeze + burst-on-recovery = the ble-delivery symptom. WRITE_PENDING_TIMEOUT_MS=150 stale-release (:216-223) only rescues the AWAIT path, cannot rescue sync native block (loop already frozen).
- Reframes "decoupled?": the await is, the native syscall isn't. Already instrumented (writeSyncMaxMs, writeSyncSlowCount ≥50ms) → testable from telemetry.
- Fix: FIRST correlate writeSyncSlowCount/writeSyncMaxMs spikes w/ freeze timestamps (competing hypothesis: GC-swap freeze). If confirmed, only real fix = noble HCI write off main loop (worker, non-trivial); document as accepted-and-monitored not "fully decoupled."
- Confidence high mechanism, medium it's THE cause vs GC/swap. Low risk (step1=measurement).

## MED simplify — Dead reconnect indirection behind permanently-false isDemandActive()
- state.ts:26 isDemandActive hardcoded return false; consumed only protocol.ts:363-374 (drain write-fail) + :440-452 (keep-alive-fail); wiring connect.ts:75 setReconnectTrigger(()=>scheduleAutoReconnect()) + protocol.ts:372,449 + :466-470 _triggerReconnect/setReconnectTrigger.
- isDemandActive always false → both proactive-reconnect branches unreachable → _triggerReconnect never invoked → whole setReconnectTrigger dead. Real reconnect = peripheral disconnect handler (connect.ts:428) + keep-alive-fail DIRECT scheduleAutoReconnect (protocol.ts:434-438).
- ~40 lines misleading control flow in 2 hottest files + cross-module setter suggesting live trigger that doesn't exist. Fix: delete isDemandActive blocks, _triggerReconnect, setReconnectTrigger, isDemandActive export. Keep direct scheduleAutoReconnect.

## MED simplify/robustness — waitForHci0Up + bringHci0Up dead code that mutates adapter against policy
- adapter-hci-check.ts:59-92. Zero callers repo-wide (bringHci0Up only self-ref :87; waitForHci0Up none). Only isHci0Up() (read-only) used by engine-start-minimal.ts:19,76-79.
- bringHci0Up runs rfkill unblock + hciconfig hci0 up via execSync; waitForHci0Up loops it. Contradicts passive-hci-wait-policy + hci-up-only-policy (engine must never up/mutate hci0 — races bluetoothd → org.bluez.Error.Busy). Harmless now (no callers) but loaded trap. Wedged-adapter is one of worst Zero2W failure modes (stuck DOWN, noble cached poweredOff for process life).
- Fix: delete bringHci0Up+waitForHci0Up; keep isHci0Up. Passive wait already correct in engine-start-minimal.ts:75-91.

## LOW-MED memory/perf — Subsystem transition log sync SD write every transition
- ble/subsystem-state.ts:61-68 _saveTransitionsToDisk=writeFileSync, from _logTransition (:82) on every markSubsystemStarting/Ready/Error/reset. Blocking writeFileSync of full JSON to SD on main loop. Flap storm → repeated sync SD I/O + wear. In-memory ring capped 50.
- Fix: debounce/coalesce (trailing timer, ~every few s) or async fire-and-forget.

## LOW simplify — Dead stat writeStuckCount drives a diagnostics readout (always 0)
- state.ts:38 declares writeStuckCount; never incremented (0 writers). Read configServer.ts:1120,1127,1228,1250 → writeStuckPerSec permanently 0 = misleading "healthy" for the exact stall it measures. Live counters: controllerStuckCount, writeStallReleaseCount.
- Fix: delete + repoint readout to writeStallReleaseCount/controllerStuckCount, or increment where stall detected. Don't ship dead gauge on freeze dashboard.

## LOW simplify — Unused noble-singleton + protocol exports
- noble-singleton.ts:18 getNobleLoadedAt, :25 onNobleStateChange (no-op), :29 getCachedNobleState — zero callers. protocol.ts:242 canWriteNow — only re-export plumbing, no consumer. Remove 3 noble-singleton helpers; decide canWriteNow (portable-API keep+comment or drop).

## LOW robustness — setEngineBleCallbacks single-slot last-wins, worked around by globalThis relay
- connect.ts:57 stores one _onConnected/_onDisconnected; index.ts:174-178 + 562-573 both call (2nd overwrites 1st), then globalThis.__lotusSetEngineCb (index.ts:574-577) so 1st re-injects. Future 2nd consumer silently wipes engine onBleConnected (keep-alive never starts). Fix: additive listener list or warn on double-register; then globalThis relay goes away. (app-glue, hardening.)

## LOW docs — Stale comments in freeze-critical files
- connect.ts:479 "FORCE 7.5ms" (actually 15ms); connect.ts:399 "5s timeout" (actual 4000); state.ts:39 + protocol.ts writeStallReleaseCount comments say ">1s" though WRITE_PENDING_TIMEOUT_MS now 150ms (protocol.ts:81-83). These are the exact lines read while debugging the freeze — wrong numbers = false trails.

**Verified correct/intentional (not flagged):** 1-slot latest-wins truly decouples await from tick (sendToBLE sync piEngine.ts:1578-1584); ACL-outstanding drain gate (protocol.ts:184-234) real backpressure reading live pending+_aclQueue; peripheral-cache purge (forceCleanupStalePeripheral) + disconnect-listener cleanup (connect.ts:409-416) prevent stale-cache hang + listener leak; resolved-guard race fixes for inner withTimeouts (connect.ts:459,502,517); idle-disconnect drain-wait (piEngine.ts:861-875) await-based not busy-loop; same-process-retry ban + process.exit(0) recovery intentional; ble-driver/(portable) vs ble/(glue) split intentional per portable-driver-layering — NOT a simplification target.
