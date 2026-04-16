

# Plan: Ersätt bluetoothctl-scan med nobles officiella scan-API

## Varför

Nuvarande `scan.ts` kör `bluetoothctl` via shell, vilket kräver:
- Stoppa noble och släppa HCI-socketen (500ms delay)
- Starta bluetoothctl som egen process
- Parsa ANSI-färgkodad textoutput med regex
- Starta om noble efteråt

`@stoprocent/noble` har ett officiellt async scan-API som eliminerar allt detta.

## Vad ändras

### 1. `pi/src/ble/scan.ts` — Helt ny implementation
Ersätt bluetoothctl-anropet med:
```typescript
await noble.waitForPoweredOnAsync();
await noble.startScanningAsync([], true); // alla enheter, allow duplicates för RSSI
// Samla enheter via 'discover' event under timeoutMs
await noble.stopScanningAsync();
```
- Inga shell-exec, ingen ANSI-parsing, ingen HCI-release
- RSSI och namn kommer direkt från `peripheral.rssi` och `peripheral.advertisement.localName`
- Behåll samma `DiscoveredDevice[]` returtyp

### 2. `pi/src/ble/adapter.ts` — Förenkling
- `stopNoble()` behövs inte längre för scan (noble äger HCI hela tiden)
- `stopBluetoothctl()` kan tas bort om bluetoothctl inte används någon annanstans
- Behåll `restartNobleHci()` och `waitForAdapter()` för connect-flödet

### 3. Ingen ändring i övriga filer
`connect.ts`, `protocol.ts`, `reconnect.ts`, `save.ts` — oförändrade.

## Teknisk jämförelse

```text
Före:                                          Efter:
stopNoble() → 500ms delay →                   waitForPoweredOnAsync() →
bluetoothctl scan le (shell) →                 startScanningAsync() →
parse ANSI + regex →                           discover events (native) →
stopBluetoothctl() →                           stopScanningAsync()
restartNobleHci()

Total overhead: ~1500ms+                       Total overhead: ~0ms
```

## Risk
Låg. Noble's scan-API är den primära dokumenterade metoden. Om det mot förmodan inte fungerar på Pi Zero 2W kan vi alltid återgå till bluetoothctl.

