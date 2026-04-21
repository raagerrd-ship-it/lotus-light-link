---
name: BLE stale-write force i active mode
description: Vid tyst musik (R=G=B=0 flera ticks) bypassar sendToBLE delta-skip efter 400ms för att hålla BLEDOM-länken vid liv (keep-alive är stoppad i active mode).
type: feature
---
**Problem:** I active mode (`playing: true`) är keep-alive-loopen STOPPAD — engine litar på att mic-vägen genererar tillräckligt med color-deltas för att hålla länken. Vid tyst musik blir output R=G=B=0 över flera ticks → delta-skip på varje tick → 0 writes → BLEDOM tappar länken efter ~7s (reason=8 supervision timeout).

**Fix i `pi/src/ble/protocol.ts` `sendToBLE()`:**

```ts
const STALE_WRITE_MS = 400;
const isStale = (now - lastWriteTime) >= STALE_WRITE_MS;
if (!process.env.BLE_NO_DELTA_SKIP && !isStale && /* delta-match */) {
  return 'no-change';
}
```

400ms = samma intervall som keep-alive-loopen. Säkert under BLEDOM supervision timeout även med jitter. Räknas som vanlig `'sent'` mot bleStats — inte som separat keep-alive.

**Komplement till** `mem://pi/ble/keep-alive` (idle mode, 200ms timer) och `mem://pi/audio/beat-driven-pulse` (active mode, mic-driven writes).
