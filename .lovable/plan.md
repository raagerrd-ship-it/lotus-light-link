## Mål

Strikt bil-tändning-flow med tre states:

```text
[Av]
  ↓ boot
[IGNITION]   — endast Sonos-poller + configServer. BLE/mic sover.
  ↓ Sonos = PLAYING
[MOTOR_ON]   — sekventiellt: BLE-minimal → connectHardcoded ∥ mic → engine.setPlaying(true)
  ↓ Sonos = PAUSED/STOPPED  (efter 1500ms re-entry-grace)
[shutdown]   — idle-färg @ 100% → drain HCI → BLE off → mic stop
  ↓
[IGNITION]
```

Manuell UI-disconnect → `IGNITION_OFF` (oförändrat).

## Skillnader mot nuläget

1. Boot startar **inte** BLE-stack ovillkorligt. `startBleEngineMinimal()` flyttas in i `toMotorOn()`.
2. `toMotorOn()` är **sekventiellt**: först `await startBleEngineMinimal()` (eliminerar `getNoble()` race), därefter `connectHardcoded()` ∥ `startMicSubsystem()` parallellt.
3. PLAYING→PAUSED triggar `shutdownToIgnition()` efter `IGNITION_REENTRY_GRACE_MS = 1500ms` (cancellerbar). Inte 2 min, inte 0 ms — undviker stutter-disconnects vid Spotify-spårbyten utan att introducera 2-min-statet.
4. `MOTOR_OFF` borttaget — det blir en transitions-fas via timer + abort-checkar, inte en stable state.
5. `applySonosStateToEngine` slutar styra `engine.setPlaying(...)`. Lifecycle's sonos-listener är **enda** kallaren av setPlaying. applySonosStateToEngine begränsas till palette/volym/TV-mode.
6. UI-knappar går via `lifecycle.userStartAll()` / `lifecycle.userStopAll()` — inte direkt mot subsystem-startarna.

## Filer

**`pi/src/engineLifecycle.ts`**
- States: `IGNITION | MOTOR_ON | IGNITION_OFF`. Ta bort `MOTOR_OFF`.
- `ignite()`: starta endast `startSonosSubsystem()` + sonos-listener. Ingen BLE-init här.
- `toMotorOn()`: 
  ```text
  1. await startBleEngineMinimal()  (sekventiellt — race-fix)
  2. parallellt: startMicSubsystem() + connectHardcoded()
  3. setState(MOTOR_ON); engineInstance.setPlaying(true)
  ```
- `scheduleShutdownToIgnition()`: setTimeout 1500ms → kallar `engineInstance.shutdownToIgnition()` → `setState(IGNITION)`. Cancellerbar via `cancelScheduledShutdown()`.
- Sonos-listener: PLAYING → cancel pending shutdown + `toMotorOn()` (om inte redan MOTOR_ON). PAUSED → `scheduleShutdownToIgnition()`.
- `userStartAll()`: rensa override → kör `toMotorOn()` även om Sonos säger PAUSED.
- `userStopAll()`: `setManualOverrideOff(true)` → kör `shutdownToIgnition()`.
- Kommentar: `engine._running` är **OUTPUT** av lifecycle-state, inte INPUT.

**`pi/src/piEngine.ts`**
- Extrahera kroppen av `handleIdleDisconnect()` till publik `shutdownToIgnition(): Promise<void>`. Behåll mid-flight abort-checkarna (`if (this.playing) return`).
- I `setPlaying(false)`: ta bort `_idleDisconnectTimer`-schemaläggningen. Behåll `forceIdleNow()` + `startKeepAlive()` så lampan står lyst tills lifecycle drar ner den.
- Ta bort `IDLE_DISCONNECT_MS`-konstanten + `_idleDisconnectTimer`-fältet (eller lämna döda för minimal diff — välj radera).

**`pi/src/index.ts`**
- `applySonosStateToEngine`: behåll palette/volym/TV-mode-logiken. **Ta bort** `engineInstance.setPlaying(...)`-anropen — lifecycle äger det nu.
- Rensa **dead code**: ta bort `setReconnectOnBootFlag()`-hookarna i crash-handlers + `consumeReconnectOnBootFlag()` + `reconnect-flag.ts`-importerna. Kommentera transitionen i memory.

**`pi/src/configServer.ts`**
- `/api/status.lifecycle` redan exponerad. Lägg till `pendingShutdownInMs` för observability.
- UI-endpoints `/api/ble/connect` & `/api/ble/disconnect` mappas till `lifecycle.userStartAll()` / `lifecycle.userStopAll()`.
- `/api/subsystem/mic/start` + `/api/subsystem/sonos/start` blir tunna no-ops om lifecycle redan kör (returnera nuvarande state).

**`src/pages/PiMobile.tsx`**
- Tre states: `IGN`, `ON`, `OFF`. Ta bort `MOTOR_OFF`-grenen.

## Verifieringsscenarier

1. Pi-reboot utan musik → IGNITION, ingen BLE, ingen mic. CPU lågt.
2. Sonos PLAY → BLE-minimal startar, lampa connectar, mic igång, blink inom ~3-5s.
3. Sonos PAUSE >1.5s → idle-färg @ 100% syns, disconnect, tillbaka till IGNITION.
4. PAUSE → PLAY inom 1500ms (Spotify-stutter, spårbyte) → pending shutdown cancelleras, motor fortsätter utan nedrivning.
5. Manual UI disconnect under MOTOR_ON → IGNITION_OFF, PLAYING ignoreras tills user reaktiverar.
6. **Process.exit-recovery**: BLE 4-fails → `process.exit(0)` → systemd restart → boot → IGNITION → sonos-poller säger PLAYING (cached på sonos-buddy) → `toMotorOn()` → blink. Inget UI-klick.

## Konstanter

```typescript
const IGNITION_REENTRY_GRACE_MS = 1500;   // PAUSE-grace innan shutdown
```

## Memory

- Uppdatera `mem://pi/runtime/sonos-driven-lifecycle.md`: 3 states, sekventiell motor-start, 1.5s grace, lifecycle = enda setPlaying-kaller.
- Markera `mem://pi/runtime/idle-disconnect-policy.md` som **superseded** — 2-min-pathen ersatt av 1.5s grace + lifecycle-shutdown.
- Markera `mem://pi/ble/auto-reconnect-loop.md` (om relevant) — auto-reconnect är nu Sonos-driven, inte flag-driven.

## Out of scope

- Längre/kortare grace än 1500ms (kan göras till env-knob senare om empiri säger annat).
- Frontend-redesign utöver state-label.
- BLEDOM-firmware-quirks.
