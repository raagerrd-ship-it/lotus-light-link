

# Plan: Uppgradera BLE direct connect till officiellt API + GATT-cache

## Bakgrund (research-resultat)

**Branschvalidering av ert mönster:**
- Always-connected med demand = rekommenderat för realtidsstyrning (PunchThrough)
- Exponentiell backoff = standard (bleak-retry-connector)
- Sparad MAC + direct connect = korrekt (Nordic Semiconductor)

**Identifierat problem:**
`nobleDirectConnect()` använder `bindings.emit('discover', ...)` — ett odokumenterat internt API. `@stoprocent/noble` har ett officiellt `noble.connectAsync(idOrAddress)` som ersätter detta.

**Optimeringsmöjlighet:**
GATT service caching — spara service/characteristic-handles så reconnect slipper full GATT discovery (~100-300ms besparad per reconnect).

## Ändringar

### 1. Ersätt `_bindings.emit('discover')` med `noble.connectAsync()`
I `connect.ts` → `nobleDirectConnect()`:
- Ta bort hela blocket som manuellt konstruerar peripheral via bindings (rad 217-256)
- Ersätt med: `const peripheral = await noble.connectAsync(savedAddress, { timeout: timeoutMs })`
- Skippa L2CAP-steget i `connectPeripheral()` eftersom peripheral redan är connected
- Behåll `waitForAdapter()` och adapter-state-check

### 2. Lägg till GATT service caching
I `state.ts`:
- Spara `serviceHandle` och `charHandle` efter första lyckade GATT discovery
- I `connectPeripheral()`: om cached handles finns, försök använda dem direkt
- Fallback till full discovery om cache misslyckas

### 3. Uppdatera `savePeripheralMetadata()`
I `save.ts`:
- Lägg till GATT handles i sparad metadata

## Teknisk detalj

```text
Före (fragilt):
  savedAddress → _bindings.emit('discover') → noble._peripherals[id] → connectAsync() → GATT discovery

Efter (officiellt API):
  savedAddress → noble.connectAsync(address) → peripheral (redan connected) → GATT discovery (cached)
```

## Berörda filer
- `pi/src/ble/connect.ts` — ersätt direct connect + lägg till GATT cache
- `pi/src/ble/state.ts` — spara/läsa GATT handles
- `pi/src/ble/save.ts` — inkludera handles i metadata

