---
name: BLE rate-limit-gate = 60% av tickMs
description: setMinWriteIntervalMs auto-följer tickMs som floor(tickMs * 0.6). Vid tick=25ms → gate=15ms. Räcker mot Pi Zero 2W timer-jitter (±3-5ms) utan att överbelasta BLEDOM.
type: feature
---
**Policy (2026-04-20):**
- Tick rate (UI-slider, 5–50ms) styr hela kedjan: mic → FFT → engine tick → BLE write
- BLE rate-limit-gate auto-sätts till `Math.max(5, Math.floor(tickMs * 0.6))` i `piEngine.setTickMs()` och konstruktorn
- Default tickMs = 25ms → gate = 15ms (66 Hz tak, faktisk takt ~40 Hz)
- Engine + UI + index.ts TICK_MS konstant: 25ms

**Varför 60% och inte tickMs - 2:**
Tidigare `tickMs - 2` gav vid tick=25 → gate=23ms. Pi Zero 2W timer-jitter (±3-5ms) gjorde att en tick som kom 22ms efter förra blockades → ~25% paket-drop helt i onödan. 60%-regeln ger gott om luft för jitter men tillåter inte burst-overflow mot BLEDOM.

**Keep-alive-semantik (samma fil):**
`startKeepAlive` sätter nu `lastWriteTime` FÖRE `writeAsync` (write-START), identiskt med `sendToBLE`. Tidigare sattes det efter resolve → första riktiga write efter keep-alive kunde blockas felaktigt av rate-limit-gaten.

**Om BLEDOM disconnectar med reason=8:** höj tick rate i UI:t (t.ex. 33ms = gate 19ms, 50ms = gate 30ms). Override via `PUT /api/ble/rate-limit` finns för debug men engine skriver över vid nästa setTickMs.

Build tag: `2026-04-20/rate-limit-60pct-tick`
