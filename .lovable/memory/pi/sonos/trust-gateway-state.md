---
name: Sonos trust-gateway-state — ingen inferens
description: sonosPoller litar enbart på gatewayens playbackState. Inga inferenser från position-rörelse, tystnad, saknad trackName, eller stale-watchdog. PLAYING → output på, PAUSED → output av. Punkt.
type: feature
---
**Princip:** Gatewayen (Cast Away) är sanningskällan för Sonos play-state. sonosPoller läser `s.playbackState` och applicerar direkt — inga gissningar.

**Borttaget (2026-04-22):**
- `inferPlayingFromPosition()` — position-delta gissade PLAYING.
- `confirmedApply()` med CONFIRM_COUNT-räknare för PAUSED-flips.
- `startStaleWatchdog()` som tvingade PAUSED efter 10s utan respons.
- "stalled position + missing playbackState → PAUSED"-inferens.
- "no trackName → PAUSED"-inferens.
- bootPhase-flagga.

**Kvar i `apply()`:** En enkel diff-detektion (playbackState, trackName, volume, isTvMode, albumArtUrl) som triggar listeners endast vid faktisk ändring.

**Auto TV-mode:** PLAYING + ingen trackName → `isTvMode = true` (om `autoTvModeEnabled`).

**Varför:** Tidigare logik kunde tvinga PAUSED mitt under låt p.g.a. tystnad eller temporärt missade tickar — engine slutade sända output trots att Sonos faktiskt spelade. Lampans säkerhet hanteras nu istället av BLE-keep-alive @200ms (alltid på när connected).
