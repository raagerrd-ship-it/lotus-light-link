---
name: Idle-disconnect efter 2 min utan musik
description: Efter 2 min Sonos-paus skickas idle-färg @ 100%, BLE disconnectar och ALSA-mic stoppas. Reconnect bara via Sonos PLAYING-event om disconnect var auto.
type: feature
---

## Regel
Efter 2 min utan musik från Sonos (hårdkodat, `IDLE_DISCONNECT_MS` i `pi/src/piEngine.ts`):
1. Engine skickar idle-färg @ 100% brightness som sista BLE-write
2. Väntar tills HCI-kö tom (max 500ms via `getOutstandingPackets`)
3. Stoppar keep-alive
4. Anropar `triggerIdleDisconnect()` i `connect-hardcoded.ts` → BLE off, markerar disconnect som AUTO
5. Anropar `stopMic()` → ALSA-capture stoppas, sparar ~20-25% CPU på Pi Zero 2 W

Lampan står lyst på idle-färgen efter disconnect (BLEDOM håller sista RGB-värdet).

## Reconnect
Triggas **enbart** av Sonos PLAYING-event i `applySonosStateToEngine` (`pi/src/index.ts`):
- `alsaMic.startMic()` om mic är inaktiv
- `connectHardcoded()` om `wasAutoDisconnected()` är true

Audio-wake via mic är medvetet uteslutet — rumssamtal skulle ge falsk-positives.

## Manual-only-policy bevarad
Om användaren manuellt disconnectar via UI sätts `_lastDisconnectWasAuto = false`.
Sonos PLAYING-pathen kollar `wasAutoDisconnected()` och kommer **inte** att auto-reconnecta efter manuell disconnect (manual-only-policy gäller).

## Anti-flap
`setPlaying` har 500ms debounce mot Sonos STOPPED→TRANSITIONING→PLAYING-flaps vid trackbyte.

## Status
`/api/status.idle` exponerar `enteredAt`, `disconnectInMs`, `micPausedForIdle`, `lastDisconnectReason`.
