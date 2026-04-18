---
name: BLE connect flow — direct + scan-fallback hybrid med skalande timeouts
description: autoConnectSaved kör direct-connect → scan-fallback. Timeouts skalar per försök 8s→12s→16s (cap). L2CAP måste vara minst 8s för BLEDOM på svag länk. Scan-fallback är OBLIGATORISK — direct-connect ensam failar på RSSI < −75.
type: feature
---
`autoConnectSaved` i `pi/src/ble/connect.ts` MÅSTE följa hybridmönstret:

1. **Direct-connect först** via `tryDirectConnectAsync` (~500ms när lampan är nära)
2. **Fall back till `nobleScanConnect`** om direct misslyckas — INTE bara `return 0`
3. **Skala timeouts per försök** via `timeoutForAttempt(getConsecutiveFailures())`:
   - Försök 1: l2cap=8s, scan=10s
   - Försök 2: l2cap=12s, scan=14s
   - Försök 3+: l2cap=16s, scan=18s (cap — längre hjälper inte)

Tidigare borttogs scan-fallbacken med kommentaren "kraschar noble-state". Det stämmer inte längre — diagnostics 2026-04-18 visade att noble är friskt poweredOn (`firstStateChangeAt` sätts korrekt, `everPoweredOn: true`).

**Empiriska timeouts (verifierade på Pi Zero 2W + ELK-BLEDOM01 @ RSSI −82):**
- L2CAP 3000ms räcker INTE — varje BLE-retransmission tar ~750ms
- BLEDOM på RSSI −82 hittades efter ~6s i fresh noble-process → scan måste vara ≥10s
- BLEDOM går i sleep efter ~30s utan trafik → andra försöket ofta möter en lampa som vaknar långsamt → därför skalningen

**Hard lock-timeout** måste vara minst 40s för att rymma direct(16s) + scan(18s) + slack.

**Symptom när hybridmönstret eller skalningen inte följs:**
- `Direct-connect failed in 3002ms` → l2cap-timeout för låg
- `connect_fail [fail#5...]` i loop utan scan-försök → fallback saknas
- Andra försöket failar lika snabbt som första → ingen skalning
- `Lock safety timeout after 12000ms` → hard ceiling för låg

**Symptom på riktig hårdvarubrist (inte kodfel):**
- Lampan syns inte ens i `noble.startScanningAsync` efter 12s → av eller utom räckhåll
- Lampan syns men connect failar trots scan-fallback → troligen parad med annan enhet (mobil)

Se mem://pi/ble/hybrid-discovery-strategy för bakgrund.
