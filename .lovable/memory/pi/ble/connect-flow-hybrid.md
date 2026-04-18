---
name: BLE connect flow — direct + scan-fallback hybrid
description: autoConnectSaved måste alltid ha scan-fallback efter direct-connect. Direct-connect failar tyst på svag länk (RSSI < -75) — scan-then-connect klarar svaga länkar. L2CAP timeout 8s, scan-fallback timeout 10s.
type: feature
---
`autoConnectSaved` i `pi/src/ble/connect.ts` MÅSTE följa hybridmönstret:

1. **Direct-connect först** via `tryDirectConnectAsync` (~500ms när lampan är nära)
2. **Fall back till `nobleScanConnect`** om direct misslyckas — INTE bara `return 0`

Tidigare borttogs scan-fallbacken med kommentaren "kraschar noble-state". Det stämmer inte längre — diagnostics 2026-04-18 visade att noble är friskt poweredOn (`firstStateChangeAt` sätts korrekt, `everPoweredOn: true`). Borttagningen var en överreaktion från ett tidigare buggläge.

**Empiriska timeouts (verifierade på Pi Zero 2W + ELK-BLEDOM01):**
- L2CAP: **8000ms** (3000ms räcker INTE när RSSI < −75 — varje retransmission tar ~750ms)
- GATT discovery: 5000ms
- Scan-fallback: 10000ms (BLEDOM på RSSI −82 hittades efter ~6s i fresh noble-process)

**Symptom när hybridmönstret inte följs:**
- `connect_fail: Direct-connect misslyckades [fail#5...]` i loop
- `Direct-connect failed in 3002ms: Direct connect timed out after 3000ms`
- noble själv är poweredOn, hci0 UP RUNNING, lampan syns i lescan — men UI:t visar "ej ansluten"

**Symptom på riktig hårdvarubrist (inte kodfel):**
- Lampan syns inte ens i `noble.startScanningAsync` efter 12s → av eller utom räckhåll
- Lampan syns men connect failar trots scan-fallback → troligen parad med annan enhet (mobil)

Se mem://pi/ble/hybrid-discovery-strategy för bakgrund.
