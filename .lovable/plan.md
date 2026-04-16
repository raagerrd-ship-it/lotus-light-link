

# BLE-modul: Post-refactor granskning

## Kritiska buggar

### 1. `adapter.ts` — `setNobleHciReleased` saknar import (RUNTIME CRASH)
Rad 26 anropar `setNobleHciReleased(false)` men funktionen importeras aldrig. Detta kraschar vid varje anrop till `restartNobleHci()`.

### 2. `nobleDirectConnect` — MAC-format fel
Rad 254: `savedAddress.toLowerCase().replace(/:/g, '')` tar bort kolon. Men noble's `connectAsync(idOrAddress)` förväntar sig MAC **med** kolon (t.ex. `aa:bb:cc:dd:ee:ff`) baserat på dokumentation och typdeklarationer. Utan kolon kan noble inte matcha adressen.

### 3. GATT "cache" gör ingenting
Rad 105-123: Trots att vi sparar `serviceHandle` och `charHandle`, anropar koden fortfarande `discoverServicesAsync([SERVICE_UUID])` + `discoverCharacteristicsAsync([CHAR_UUID])` — exakt samma som icke-cachad väg. Ingen tidsbesparing.

**Lösning:** Noble har `peripheral.writeHandleAsync(handle, data, withoutResponse)` — med cachade handles kan vi skriva **direkt utan GATT discovery**.

## Prestandaoptimeringar

### 4. `ConnectOptions` har `minInterval`/`maxInterval`
Noble's `connectAsync()` accepterar connection interval-parametrar direkt:
```typescript
noble.connectAsync(address, {
  addressType: 'public',
  minInterval: 6,   // 7.5ms
  maxInterval: 8,   // 10ms
});
```
Detta ersätter det separata `requestConnectionInterval()` HCI-anropet och sätter intervallet **redan vid connect**.

### 5. `waitForPoweredOnAsync()` — ersätter manuella loops
Noble har en inbyggd `waitForPoweredOnAsync(timeout?)`. Ersätter:
- `waitForAdapter()` i `adapter.ts` (10-iteration poll-loop)
- Adapter-väntan i `scan.ts` (manuell stateChange-listener)

### 6. `nobleConnect` anropar `restartNobleHci` ovillkorligt
Rad 292 bör ha samma villkorliga check som `nobleDirectConnect` — skippa om adapter redan är `poweredOn`.

## Cleanup

### 7. `restartNobleHci` anropar fortfarande `stopBluetoothctl()`
Bluetoothctl används inte längre efter scan-refaktorn. Ta bort anropet och delays.

### 8. `index.ts` kommentarer
Rad 1 och 28 refererar fortfarande till "bluetoothctl discovery".

## Plan

### Steg 1: Fixa import-crash i `adapter.ts`
Lägg till `setNobleHciReleased` i importen från `./state.js`.

### Steg 2: Fixa MAC-format i `nobleDirectConnect`
Behåll kolon i adressen: `savedAddress.toLowerCase()` (utan `.replace(/:/g, '')`).

### Steg 3: Riktig GATT-cache med `writeHandleAsync`
I `connectPeripheral()`: om cachade handles finns, skapa ett minimalt characteristic-objekt som använder `peripheral.writeHandleAsync(charHandle, ...)` direkt. Skippa `discoverServicesAsync` + `discoverCharacteristicsAsync` helt.

Fallback till full discovery om `writeHandleAsync` misslyckas.

### Steg 4: Connection interval via `ConnectOptions`
Lägg till `minInterval: 6, maxInterval: 8` i `noble.connectAsync()` options. Behåll `requestConnectionInterval()` som fallback för `nobleConnect`-vägen (scan-based).

### Steg 5: Ersätt adapter-wait med `waitForPoweredOnAsync`
- `adapter.ts` → `waitForAdapter()`: `await noble.waitForPoweredOnAsync(5000)`
- `scan.ts` → adapter-wait: `await noble.waitForPoweredOnAsync(5000)`

### Steg 6: Villkorlig `restartNobleHci` i `nobleConnect`
Samma check som `nobleDirectConnect` — skippa om `poweredOn`.

### Steg 7: Ta bort `stopBluetoothctl` och städa kommentarer
- Ta bort `stopBluetoothctl()` från `adapter.ts`
- Uppdatera kommentarer i `index.ts`

## Sammanfattning

| Problem | Typ | Påverkan |
|---------|-----|----------|
| Saknad import | BUG | Runtime crash |
| MAC utan kolon | BUG | Anslutning misslyckas |
| Falsk GATT-cache | PERF | 100-300ms bortkastad |
| Connection interval vid connect | PERF | Snabbare anslutning |
| Manuell adapter-wait | PERF | Onödig kod |
| Ovillkorlig `restartNobleHci` | PERF | +600ms vid scan-connect |
| Bluetoothctl-rester | CLEANUP | Död kod |

Berörda filer: `connect.ts`, `adapter.ts`, `scan.ts`, `index.ts`, `protocol.ts` (PiCharacteristic-typ för writeHandleAsync).

