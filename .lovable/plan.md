
# Sonos-driven engine lifecycle

Ersätt dagens fragila `/tmp/lotus-auto-reconnect-on-boot`-baserade auto-restart med en lifecycle-state-machine där **Sonos playbackState är källan till sanning** för om motorn ska köra. Pi:n beter sig som en bil: tändningen är alltid på (sonos-poller + BLE-stack ready), och musik = motor på.

## States

| State | Aktivt | Sover |
|---|---|---|
| TÄNDNING | sonos-poller, configServer, BLE-engine-minimal | mic, BLE-connect, engine.tickInner |
| MOTOR_PÅ | + alsaMic, BLE connected, engine.setPlaying(true) | — |
| MOTOR_AV | sonos-poller, BLE keep-alive (idle-färg) | mic, engine produktion |
| TÄNDNING_AV | sonos-poller endast | mic, BLE, engine — tills användaren manuellt återaktiverar |

## Triggers

```text
Boot → ignite():
  startBleEngineMinimal()   // ovillkorligt, ingen connect
  startSonosSubsystem()     // alltid igång
  läs lifecycleOverride från storage (TÄNDNING_AV?)
    → om ja: stanna i TÄNDNING_AV, ignorera sonos
    → annars: state = TÄNDNING, lyssna på sonos

onSonosChange:
  PLAYING && state ∈ {TÄNDNING, MOTOR_AV}  → toMotorOn()
  PAUSED  && state === MOTOR_PÅ            → toMotorOff() (engine.setPlaying(false))
  PAUSED >2 min → idle-disconnect path (befintlig)

UI manual disconnect → state = TÄNDNING_AV, persist override
UI manual "Starta allt" → rensa override, ignite() pathen
```

## Filer att ändra (pi/src/)

**Ny: `pi/src/engineLifecycle.ts`**
- Exporterar `LifecycleState` enum + `getLifecycleState()` + `subscribeLifecycle()`.
- `ignite()` — kallas från boot. Startar BLE-engine-minimal + sonos-subsystem ovillkorligt. Subscribear sonos-state och driver transitions.
- `toMotorOn()` — `startMicSubsystem()` + `connectHardcoded()` parallellt (flytta logiken som idag sitter i `applySonosStateToEngine`).
- `toMotorOff()` — `engineInstance.setPlaying(false)`. Idle-disconnect efter 2 min hanteras redan av piEngine (`idle-disconnect-policy`).
- `manualDisconnect()` / `manualOverrideOff()` — sätter persistent flagga via `storage.setItem('lifecycle-override', 'off' | '')`.

**`pi/src/index.ts`**
- Ta bort `consumeReconnectOnBootFlag()`-blocket (rad 405–427). Ersätt med `await ignite()`.
- Behåll `setReconnectOnBootFlag`-anropen i crash-handlers (rad 436, 446) — blir no-op på read-sidan men billigt och bevarar bakåtkompatibilitet om någon downgrade. *(Alternativt: städa bort hela `reconnect-flag.ts` — fråga om önskat.)*
- Flytta sonos→engine-couplingen från `applySonosStateToEngine` (rad 103–122, ALSA + connectHardcoded i sonos-handlern) in i `engineLifecycle.toMotorOn()` så det körs via state-machinen istället för direkt i poller-callbacken.
- Lämna kvar `applySonosStateToEngine`'s palette/volym/TV-mode-arbete — det behöver fortfarande köras varje state-tick.
- Behåll `/api/subsystem/mic/start`, `/api/ble/connect`, `/api/subsystem/sonos/start` som override-endpoints (UI-knapp). De ska kunna trigga `manualOverrideOff()`-clear så lifecycle tar över igen.
- Boot-loggar: skriv "Tändning aktiv — väntar på Sonos PLAYING" istället för "väntar på subsystem-start från UI/API".

**`pi/src/sonosPoller.ts`**
- Inga större ändringar. §2A (fresh-status-on-subscribe) + §2B (position-heartbeat) är redan på plats.
- Bekräfta att `onSonosChange` resolvar innan `markSubsystemReady('sonos')` så lifecycle ser current state direkt.

**`pi/src/ble/connect-hardcoded.ts`**
- Ingen ändring. `process.exit(0)` på 4 consecutive fails kvarstår — efter exit startar systemd, `ignite()` körs, sonos säger PLAYING → motor på igen. Disk-flagga behövs inte längre för recovery, bara som redundant skydd.

**`pi/src/configServer.ts`**
- Lägg till `lifecycleState` + `lifecycleOverride` i `/api/status`-payloaden.
- Nytt endpoint `POST /api/lifecycle/override` med `{ off: boolean }` så UI kan toggla TÄNDNING_AV explicit.

## Migration / kompabilitet

- `reconnect-flag.ts` lämnas kvar men `consumeReconnectOnBootFlag()` anropas inte längre. Crash-handlers fortsätter sätta flaggan (no-op effekt), så vi kan rolla tillbaka utan migration om något går snett.
- `/tmp`-flagga vid Pi-reboot: nu irrelevant — sonos-state-driven återstart fungerar oavsett om `/tmp` wipas.
- Befintlig idle-disconnect-policy (mem://pi/runtime/idle-disconnect-policy) bevaras helt — den är nu en transition INOM MOTOR_AV, inte konkurrerande med lifecycle.

## Verifieringsscenarier

1. Pi-reboot mid-PLAYING → engine blinkar inom ~10s, ingen UI-klick.
2. `systemctl restart lotus-light-engine` mid-PLAYING → samma.
3. BLE 4 consecutive fails → process.exit → systemd restart → ignite → sonos PLAYING → motor på.
4. Sonos pause 1s + play → engine stannar kort, vaknar direkt.
5. Sonos pause >2 min → MOTOR_AV, BLE keep-alive idle-färg, BLE disconnect efter 2 min idle.
6. UI manual disconnect → TÄNDNING_AV, sonos PLAYING triggar INTE motor förrän user reaktiverar.

## Memory-uppdatering

- Ny memory: `mem://pi/runtime/sonos-driven-lifecycle.md` (feature) — beskriver state-machine + override-flagga.
- Uppdatera `mem://pi/runtime/auto-restart-on-crash.md` — markera reconnect-flag som "legacy redundant" (kvar som safety net, ej primär driver).
- Uppdatera `mem://index.md` Core: "Lifecycle drivs av Sonos playbackState. Manual UI-disconnect sätter override som blockerar auto-start."

## Out of scope

- BLEDOM-firmware-quirks
- PCC autoscaler-bursts
- Sonos-buddy (separat process, ingen ändring)
- Frontend-ändringar (förutom ev. liten badge för lifecycleState i `PiMobile.tsx` om önskat — kan göras i uppföljnings-PR)
