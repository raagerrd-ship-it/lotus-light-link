---
name: Sonos-driven engine lifecycle (3-state bil-tändning)
description: Strikt 3-state lifecycle. IGNITION = bara sonos-poller. PLAYING → sekventiell motor-start (BLE-minimal → mic∥connect). PAUSED → shutdownToIgnition efter 1500ms grace. Lifecycle är ENDA setPlaying-ägaren.
type: feature
---

## States

| State | Aktivt | Sover |
|---|---|---|
| `IGNITION` | configServer, sonos-poller | BLE, mic, engine |
| `MOTOR_ON` | + BLE-stack, lampa connected, alsaMic, engine.setPlaying(true) | — |
| `IGNITION_OFF` | sonos-poller | BLE, mic, engine — tills user reaktiverar |

`MOTOR_OFF` finns INTE som stable state — PAUSED är bara en cancellerbar
transition tillbaka till IGNITION via `IGNITION_REENTRY_GRACE_MS = 1500ms`.

## Sekventiell motor-start (race-fix)

`toMotorOn()` (i `pi/src/engineLifecycle.ts`):
1. `await startBleEngineMinimal()` — sekventiellt först, eliminerar
   `getNoble() called before getNobleAsync()` race.
2. Parallellt: `startMicSubsystem()` + `connectHardcoded()`.
3. `setState('MOTOR_ON')`; `engineInstance.setPlaying(true)`.

## PAUSE-grace (1500ms)

PLAYING→PAUSED triggar `scheduleShutdownToIgnition()` med 1500ms timer.
Cancelleras direkt om PLAYING återkommer (Spotify-stutter, spårbyte).
Vid timeout: `engine.shutdownToIgnition()` → idle-färg @ 100% → drain HCI →
BLE off → mic stop → `setState('IGNITION')`.

## Lifecycle = enda setPlaying-ägaren

`applySonosStateToEngine` i `pi/src/index.ts` styr ENBART palette/volym/TV-mode.
`engine.setPlaying()` kallas uteslutande från lifecycle-transitions. Detta
eliminerar dubbla källor som tidigare kunde flippa engine-state ur fas med
lifecycle-state.

## UI-endpoints
- `POST /api/ble/connect` → `userStartAll()` (rensar override + toMotorOn).
- `POST /api/ble/disconnect` → `userStopAll()` (override on + shutdown).
- `POST /api/lifecycle/override { off }` → explicit toggle.
- `/api/status.lifecycle` → `{ state, manualOverrideOff, pendingShutdownInMs }`.

## Connect-retry inom MOTOR_ON

Om initial `connectHardcoded()` failar i `toMotorOn()` (t.ex. BLEDOM svarar
inte) startas en backoff-sekvens i `engineLifecycle.ts`:
`scheduleConnectRetries()` med schema `[2s, 5s, 10s, 20s]` (4 försök, ger
upp efter ~37s). Cancelleras direkt av:
- PAUSED (`scheduleShutdownToIgnition` kallar `cancelConnectRetries`)
- `userStopAll()` (manuell disconnect)
- Ny `toMotorOn()`-cykel (cycle-token bumpas)
- Lyckad connect (egen path eller annan)

Räknas oberoende av `CONSECUTIVE_FAIL_LIMIT` i `connect-hardcoded.ts` —
process.exit-pathen där lever kvar som last-resort.

## Process.exit-recovery
BLE 4-fails → `process.exit(0)` → systemd restart → boot → IGNITION →
sonos-poller säger PLAYING (cached på sonos-buddy) → `toMotorOn()` →
blink. Inget UI-klick. `/tmp/lotus-auto-reconnect-on-boot` är legacy
(no-op vid read), kvar bara som redundant safety net.

## Supersedes
- `mem://pi/runtime/idle-disconnect-policy` — 2-min idle-disconnect-pathen
  är borttagen. Ersatt av lifecycle-shutdown direkt vid PAUSED + 1.5s grace.
