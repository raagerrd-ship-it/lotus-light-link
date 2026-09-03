# RAW FINDINGS — Agent 5: index.ts / engineLifecycle / runtimeHealth / restartLog / subsystem-state / engine-start-minimal / debugLog

## POSITIVE VERIFICATIONS (core design sound — do NOT "fix")
- Watchdog watches RIGHT signal: freeze cond (index.ts:462) gates ONLY on getEngineTickTotal() (analysis tick, incremented solely in piEngine.onFFTFrame→noteTick piEngine.ts:1155). bleStats.tickOkCount logged but never gates restart → pure BLE-delivery stall (WiFi contention/hung write) while analysis keeps ticking NEVER hard-restarts. Answers the central question correctly.
- Escalation conservative: to reach process.exit(1), engine tick frozen continuously through 8s + 3 failed soft-recovery windows (each re-arms 8s) ≈ ~32s sustained freeze. Transient GC/swap freeze self-resolves (stuckMs reset index.ts:462-469) → won't over-trigger. Heap-cap (96MB) is right layer for swap-storm, not watchdog.
- Timer hygiene good: single 1Hz scheduler (index.ts:397-407), single playback-watchdog (dup removed, :386-388). Ring-buffers bounded: restart-log MAX_ENTRIES=50, transitions MAX_TRANSITIONS=50. No leaks. Heap cap 96MB on ~416MB usable sane.

## MED robustness — Crash & signal handlers registered LAST → early-boot crashes unlogged
- index.ts:626-644 (uncaughtException/unhandledRejection), :661-662 (SIGINT/SIGTERM), vs :665 main().catch.
- Handlers installed at END of main(), after all async boot: logRuntimePermissions, config-server start, watchdog IIFE, await ensureEngineInstance, dynamic imports, ignite(). Any rejection/throw in that window caught only by top-level main().catch (logs [Fatal] exit(1) WITHOUT recordRestart/markGracefulShutdown/flag) or Node default. → no restart-log reason + leaves SESSION_MARKER → next boot mislabels unknown-systemd-restart. Same for SIGTERM mid-boot.
- Zero2W: boot is exactly when fragile (native ALSA/noble, slow SD imports). Losing reason on most diagnostic failures undermines restart-log tuning loop.
- Fix: register uncaughtException/unhandledRejection (+signals) at module top-level / first lines of main() before any await; lazily import() recordRestart/markGracefulShutdown inside handler.

## MED robustness/smarter — Absent/un-initializable mic in MOTOR_ON → ~45-60s hard-restart crash-loop
- watchdog index.ts:449-519; lifecycle tolerates mic-start fail engineLifecycle.ts:221-236 (state already MOTOR_ON set :206); restartCapture returns false when capture null (alsaMic.ts:936-937).
- In MOTOR_ON, engineTickTotal only advances when mic feeds FFT. If startMicSubsystem fails (error swallowed in toMotorOn) or mic absent/wedged won't re-init, ticks frozen → watchdog micFrozen → restartCapture (false, no-op) ×3 → exit(1). systemd restart → Sonos still PLAYING → toMotorOn → frozen → exit. Each cycle writes restart-log.
- Watchdog can't distinguish "mic hardware gone" (restart won't help) from "capture wedged" (restart might). Indefinite loop, dark lamp, steady SD writes.
- Fix: treat restartCapture()===false (capture null) as non-restartable — back off not count toward exit budget; and/or only escalate tick-freeze to exit(1) if mic ever ready/≥1 audio cb this session; optional exp backoff to systemd restart when last N restart-log entries share reason.

## LOW-MED robustness — doShutdown() leaves state==MOTOR_ON across drain await
- engineLifecycle.ts:167-179. setPlaying(false) (freezes engineTickTotal) at :173, setState('IGNITION') only :178 AFTER await eng.shutdownToIgnition() (HCI drain, seconds). During await watchdog sees MOTOR_ON+frozen ticks → if drain exceeds window, runs recovery during intentional shutdown (restartTimer benign no-op since playing===false, but restartCapture could needlessly bounce mic).
- Fix: transient non-MOTOR_ON state or _shuttingDown flag watchdog checks before await.

## LOW-MED correctness/doc — IGNITION_REENTRY_GRACE_MS value contradicts 3 comments
- engineLifecycle.ts:26 =3_000, header :11-14 says "(5 min)", piEngine.ts:996 says "1500ms", note sonos-driven-lifecycle.md says "1500ms". Actual 3s. Governs how fast BLE tears down on pause. Reconcile all to intended value.

## LOW perf/accuracy — Freeze duration assumed not measured
- index.ts:471 stuckMs += INTERVAL_MS (fixed 2000ms/fire). But setInterval(1000) coalesced by libuv under loop lag (fires once after long block, not N times) → stuckMs UNDER-counts real wall-clock during exactly the lag it cares about. Logged "FROZEN Xms" + 8s threshold drift.
- Fix: track lastFireAt=Date.now(), add real delta. (Conservative — under-counts → later restart — so accuracy only.)

## LOW simplify — 8s micFrozen recovery largely duplicates 1.5s mic-stall fast path
- unconditional fast path index.ts:445-447 (isMicStalled @ MIC_STALL_MS=1500, alsaMic.ts:924-933) vs micFrozen branch index.ts:497-498. 1.5s detector runs every 2s regardless, calls restartCapture long before 8s. So 8s micFrozen mostly fires only in the case fast path is blind to: isMicStalled false while _lastAudioCbAt===0 (alsaMic.ts:931) — right after restart, mic never delivered first cb. That BLIND SPOT (not redundancy) is why 8s branch is load-bearing.
- Fix: track "capture started but never delivered" as its own stall so 1.5s path catches mic that never returns → 8s micFrozen simplifiable; or document 8s branch exists only for post-restart-never-delivered. (Overlaps alsaMic agent MED #3.)

## LOW simplify — restart-log 5s recency-dedup effectively dead
- restartLog.ts:111-123. Reaching `recent` check requires SESSION_MARKER to still exist, but every reason-logging path removes it (crash handlers index.ts:630,640; BLE fail :547; watchdog exit :517 all markGracefulShutdown after recordRestart). So noteBootStart reaches recency only on genuine unknown death where last entry unrelated + always >5s old → guard never suppresses. Remove or comment as redundant. Also RestartReason includes alsa-watchdog-stuck/manual-start-all no longer recorded.

## LOW robustness — shutdown() awaits BLE disconnect with no timeout
- index.ts:648-660 await disconnectHardcoded() unbounded; hung disconnect blocks exit(0) until systemd SIGKILL. (Ordering good — flag+markGracefulShutdown before await.) Fix: const t=setTimeout(()=>process.exit(0),2000); t.unref?.().

## LOW logging — Non-hot console.log where dlog is documented rule
- applySonosStateToEngine color/palette/TV logs index.ts:109,133,143 fire every track/palette change → fill tiny systemctl ring (journald persists nothing). Route through dlog().

**Net:** watchdog central design correct + doesn't over-trigger. Strongest: late crash-handler registration (#1) + mic-absent restart-loop (#2, only meaningful SD-wear risk). Rest small-radius.
