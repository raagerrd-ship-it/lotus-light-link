---
name: Sonos stale-watchdog förhindrar fastnad PLAYING
description: sonosPoller har 10s watchdog som tvingar PAUSED om varken SSE eller poll svarat under playing. Skydd mot fastnad output när Sonos pausar och pause-eventet missas eller gateway tappar kontakt.
type: feature
---
**Symptom utan watchdog:** Sonos pausar (II i UI), men engine fortsätter skicka RGB-output till lampan eftersom inget event nådde fram.

**Implementation (`pi/src/sonosPoller.ts`):**
- `startStaleWatchdog()` körs varje 2s.
- Om `currentState.playbackState` innehåller `PLAYING` OCH `max(lastResponseTime, lastSuccessfulPollAt)` är >10s gammalt → `apply({ ...state, playbackState: 'PLAYBACK_STATE_PAUSED' })`.
- Listeners (inkl. `applySonosStateToEngine`) får eventet → `engine.setPlaying(false)` → owner=idle, keep-alive tar över idle-färgen, sendToBLE stoppas.
- Watchdogen startas i `startSonosPoller`, stoppas i `stopSonosPoller`.

**Bonusfix:** `apply()`s `changed`-detection inkluderar nu också `albumArtUrl` (annars triggar palette-byten inte listeners om bara art-URL ändrats utan track-byte).

Verifierat 2026-04-22.
