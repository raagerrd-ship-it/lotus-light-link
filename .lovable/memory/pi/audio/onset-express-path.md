---
name: Sub-frame onset express BLE write
description: pi/src/piEngine.ts processOnset triggar direkt sendToBLE på confirmed onset, kringgår tick-gate för ~13ms kick-to-light istället för 25-50ms
type: feature
---

På confirmed onset (samma plats som onsetTarget = 0.45 sätts) skickar
processOnset en sub-frame BLE-write direkt med `_finalColor` + boostad
brightness. Bypass:ar tick-gaten så lampan reagerar på FFT-takt.

**Latency**: kick-to-light ~25–50ms (avg 32) → ~13–20ms (avg 17).

**Invariants**:
- Refractory-gaten (cal.onsetRefractoryMs) bounded express-write till ≤1 per onset.
- Guard: `_bleOwner === 'active' && lastSentPct >= 0` (säkerställer att
  `_finalColor` är initierat av minst ett tickInner).
- Updaterar `lastSentPct` på 'sent' så tickInner-deadband inte sväljer
  den naturliga down-stroke-droppen på nästa tick.
- `this.smoothed` rörs INTE — tickInner äger EMA-tailen.

**Dependency**: ACL-outstanding-gate (acl_max_pkt - margin = 6) MÅSTE vara
aktiv. Annars riskerar express + tickInner att fylla HCI-bufferten i samma
tick-fönster.

**Relaxed slot-lease**: setSlotLeaseMs(tickMs/3) i constructor + setTickMs.
Vid tickMs=20 → ~7ms lease. Lämnar plats för tickInner-write + 1 express-write
per tick utan att gå över ACL_MAX_OUTSTANDING.

**Adaptiv release-alpha**: tickInner skalar releaseAlpha proportionellt
mot drop-magnitud (dropBoost default 0.6, threshold 0.05, ceiling 0.85).
Hårda drops snappar tailen, mjuka decay behåller silky-releasen.

**Telemetri (bleStats)**:
- `onsetExpressCount` — express-writes som skickades (förvänta 1.5–4/s vid drumming)
- `onsetExpressBusyCount` — abort pga lease/ACL-gate (< 5% av total OK)
- `adaptiveReleaseAlphaMax` — high-water av computed alpha (sanity 0.15–0.85)
- `slotLeaseMs` — aktuell effektiv lease

Build tag: `2026-04-29/onset-express`
