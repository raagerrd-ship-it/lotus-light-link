---
name: Sonos subscribe-race fix + position heartbeat
description: onSonosChange är async, fetchar fresh status (cap 1500ms) före replay; apply() emittar heartbeat var ~10s position-bucket så engine recovera även om subscribed mid-track
type: feature
---

**Två race-buggar i `pi/src/sonosPoller.ts` som fixades 2026-05-02:**

1. **Subscribe-race:** `onSonosChange` replay:ade `currentState` (default IDLE) om subscribern registrerade sig innan första pollen löste. Engine missade då boot-time PLAYING. Fix: `onSonosChange` är nu `async`, kör `fetchStatusOnce()` race:at mot 1500ms timeout, applyar via `parseStatus`, sen `fn(currentState)`. Caller i `pi/src/index.ts` måste `await` så subsystem inte markeras READY innan fresh-status hunnit dropp:as in.

2. **Stable-PLAYING-blindspot:** `apply()` fan-out:ade bara på meta-changes, så när engine startade mid-track utan meta-events kom det aldrig en `setPlaying(true)`. Fix: även `positionHeartbeat = floor(next.positionMs/10000) !== floor(currentState.positionMs/10000)` triggar listeners → engine får ping var ~10s så länge musik spelar.

Tillsammans med BLE-callback-wiring vid engine-create (mem://pi/ble/...) gör detta att `systemctl restart lotus-light-engine` eller `process.exit`-recovery är helt transparent för användaren — ingen UI-klick behövs.
