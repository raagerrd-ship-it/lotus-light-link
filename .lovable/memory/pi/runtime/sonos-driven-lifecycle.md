---
name: Sonos-driven engine lifecycle (bil-tändning-modell)
description: Sonos playbackState är källan till sanning för engine-on/off. Boot kör ignite() (BLE-engine-minimal + sonos-poller); PLAYING triggar mic+connect. Manuell UI-disconnect sätter override som blockerar auto-start tills user reaktiverar.
type: feature
---

## Modell

| State | Aktivt | Sover |
|---|---|---|
| `IGNITION` | sonos-poller, configServer, BLE-engine-minimal | mic, BLE-connect, engine produktion |
| `MOTOR_ON` | + alsaMic, BLE connected, engine.setPlaying(true) | — |
| `MOTOR_OFF` | sonos-poller, BLE keep-alive (idle-färg) | mic, engine produktion |
| `IGNITION_OFF` | sonos-poller endast | mic, BLE, engine — tills user reaktiverar |

## Implementation
- `pi/src/engineLifecycle.ts` exporterar `ignite()`, `getLifecycleState()`, `setManualOverrideOff()`, `isManualOverrideOff()`.
- Boot i `pi/src/index.ts` kör `ignite({...})` ovillkorligt efter configServer up. ignite() startar `startBleEngineMinimal()` + `startSonosSubsystem()` parallellt och subscribear `onSonosChange` (som replay:ar fresh state direkt — se mem://pi/sonos/subscribe-race-fix).
- PLAYING (eller TV-mode) → `toMotorOn()` → `startMicSubsystem()` + `connectHardcoded()` parallellt. PAUSED → `toMotorOff()` → state-byte; engine.setPlaying(false) sköts av `applySonosStateToEngine`. Idle-disconnect efter 2 min hanteras av piEngine (mem://pi/runtime/idle-disconnect-policy).
- Manuell UI-disconnect via `POST /api/ble/disconnect` → `setManualOverrideOff(true)` → `IGNITION_OFF`. Sonos PLAYING ignoreras tills `POST /api/ble/connect` eller `POST /api/lifecycle/override { off: false }` rensar override.
- Override persisteras via `storage.setItem('lifecycle-override', 'off')` så den överlever Pi-reboot.

## Varför detta ersatte /tmp-flaggan
Tidigare `/tmp/lotus-auto-reconnect-on-boot` rensades av SIGTERM (inkl `systemctl restart`) och försvann vid Pi-reboot. Sonos-driven recovery fungerar oavsett restart-orsak — gateway-state är källan. Disk-flaggan kvarstår som no-op safety net (skrivs av crash-handlers + post-connect-hook) men consumeras inte längre vid boot — vi anropar `consumeReconnectOnBootFlag()` bara för att dränera ev. legacy-flagga.

## Status-exponering
`/api/status.lifecycle = { state, manualOverrideOff }`. Endpoint `POST /api/lifecycle/override { off: boolean }` togglar override explicit.
