---
name: Never force-mutate noble.state
description: noble.state får ALDRIG mutereras manuellt — vänta alltid på riktig stateChange via waitForPoweredOnAsync(10000) före scan/connect
type: constraint
---
**Förbjudet:** `noble._state = 'poweredOn'` (eller motsvarande "force-mutate"-helper).

**Varför:** Strängvärdet bytar bara namn — noble's interna HCI-init körde aldrig klart. Resultat:
- `startScanningAsync()` returnerar OK men skickar inget HCI-kommando → 0 discover-events
- `connectAsync()` blir no-op
- Loggen ljuger ("state=poweredOn") medan inget faktiskt händer

**Bevis (SSH-test 2026-04-18):**
- Med force-mutate: `total= 0` discover-events på 5s
- Utan force-mutate, bara `await noble.waitForPoweredOnAsync(10000)`: riktig `stateChange -> poweredOn` på +254ms, **202 discover-events** på 5s, ELK-BLEDOM01 hittad på +411ms

**Regel:** Före varje `startScanningAsync` / `connectAsync` / `peripheral.connectAsync`:
```ts
await (noble as any).waitForPoweredOnAsync(10_000);
```
Inget annat. Ingen `_state`-mutation. Ingen "best-effort" helper. Om wait failar → returnera fel, försök inte fortsätta.

**Gäller alla tre kodvägar i `pi/src/ble/connect.ts`:**
1. `connectPeripheral` (L2CAP-grenen)
2. `nobleScanConnect` (scan-then-connect)
3. `tryDirectConnectAsync` (direct-connect)

Build-tagg som etablerade fixen: `2026-04-18/wait-real-statechange-no-force-mutate`.
