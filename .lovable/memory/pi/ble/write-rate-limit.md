---
name: BLE write rate styrs av tick rate, inte hårdkodad limit
description: Tick rate-slidern (UI) är ENDA källan för hur ofta BLE-paket skickas. Min 25ms = 40 pkt/s tak. Ingen separat MIN_WRITE_INTERVAL_MS i protocol.ts.
type: feature
---
**Tidigare problem (2026-04-19):** `protocol.ts` hade hårdkodad `MIN_WRITE_INTERVAL_MS = 66` som gav max ~15 pkt/s. Tick rate-slidern (UI) kunde sättas till 10ms men paketen skickades ändå max var 66:e ms → slidern ljög, kedjan inte linjär.

**Nuvarande policy:**
- Tick rate (UI-slider, 25–50ms) styr hela kedjan: mic → FFT → engine tick → BLE write
- Min 25ms = 40 pkt/s tak (BLEDOM-säker enligt fälttest)
- INGEN separat rate-limit i `protocol.ts` — bara `writeInFlight`-skydd mot parallella writes
- Backend-validering: `/api/tick-ms` accepterar 25–50ms
- Engine + UI default: 25ms

**Om BLEDOM disconnectar med reason=8:** höj tick rate i UI:t (t.ex. 33ms = 30 pkt/s, 50ms = 20 pkt/s). Aldrig återinför hårdkodad limit i protocol.ts — då ljuger slidern igen.

Build tag: `2026-04-19/tick-rate-single-source-of-truth`
