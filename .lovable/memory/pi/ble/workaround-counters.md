---
name: BLE workaround usage counters
description: workaroundCounters i pi/src/ble/state.ts spårar defensiva fallbacks. Counter=0 efter en vecka i drift → död kod, kan rensas.
type: feature
---
**Syfte:** Mäta vilka defensiva BLE-workarounds som faktiskt triggas i drift, så vi efter ren PCC-installation vet vad som kan rensas bort.

**Counters (`workaroundCounters` i `pi/src/ble/state.ts`):**
- `forceNoblePoweredOn_invoked` — totalt antal anrop
- `forceNoblePoweredOn_skippedHealthy` — bailade direkt (effective state OK)
- `forceNoblePoweredOn_neededRefresh` — gick vidare till refresh-loop
- `resetHciAdapter_invoked` — `hciconfig down/up/reset` körd
- `hardBluetoothRestart_invoked` — `systemctl restart bluetooth` (last resort)
- `manualBleReset_invoked` — POST `/api/ble/reset` från UI-knappen
- `restartNobleHci_invoked` — noble HCI-listener refresh
- `capsOverride_applied` — `getAdapterState()` rapporterade poweredOn när raw=unknown
- `capsSelfCheck_failed` — saknar CAP_NET_RAW/CAP_NET_ADMIN vid boot
- `lastInvocationAt[key]` — ISO-tidsstämpel för senaste trigger

**Synlig i:** `GET /api/ble/diagnostics` → `workarounds` i JSON-svaret.

**Beslutsregel:** Efter ~1 vecka stabil drift på ren PCC-installation:
- Counter=0 OCH `_skippedHealthy` ≫ `_neededRefresh` → workaround är död, rensa.
- Counter>0 → behåll, dokumentera vad som triggade.

**Implementation:** `bumpWorkaround(key)` helper i `state.ts` ökar counter + sätter `lastInvocationAt[key]`. Anropas på alla defensiva paths.
