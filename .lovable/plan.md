

# BLE-modul: Slutlig granskning — tre kvarvarande problem

## Status
Modulen är i **bra skick** efter alla tidigare refaktorer. Scanning, direct connect, GATT-cache, reconnect, keep-alive och demand-logik är alla stabila och använder officiella API:er. Tre mindre problem kvarstår:

## 1. Död `_nobleHciReleased`-override i `getAdapterState()` (state.ts:170-173)
Denna branch sätter `poweredOff` → `poweredOn` när noble HCI "avsiktligt släppts" för bluetoothctl. Men bluetoothctl är borttagen — `_nobleHciReleased` sätts aldrig till `true` i den nya koden. Branchen är **oanvändbar** och kan maskera riktiga `poweredOff`-tillstånd om den av misstag triggas.

**Åtgärd:** Ta bort den döda branchen (rad 170-173) i `getAdapterState()`.

## 2. `discoverSomeServicesAndCharacteristicsAsync` felaktig resultatparsning (connect.ts:149-153)
Fallback-pathen förväntar sig `result.characteristics` (objekt), men noble returnerar en **array** `[services, characteristics]`. Om den tvåstegs-discovery misslyckas och fallback triggas, returneras `undefined` → tom array → retry → onödig fördröjning.

**Åtgärd:** Ändra till:
```typescript
const [, characteristics] = await withTimeout(
  peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CHAR_UUID]),
  'Combined GATT discovery'
);
```

## 3. Synkron `startScanning` i `nobleConnect` (connect.ts:336)
`nobleConnect` använder `noble.startScanning([], true)` (synkron) medan resten av modulen använder `startScanningAsync`. Synkrona versionen kastar inte promise-rejection vid fel — felet fångas bara i try/catch som sync throw.

**Åtgärd:** Byt till `await noble.startScanningAsync([], true)`.

## Berörda filer
- `pi/src/ble/state.ts` — ta bort död override-branch
- `pi/src/ble/connect.ts` — fixa GATT fallback-parsning + async scan

## Sammanfattning

| Problem | Typ | Risk |
|---------|-----|------|
| Död HCI-released override | CLEANUP | Kan maskera poweredOff |
| Felaktig array-destructuring | BUG | GATT fallback misslyckas tyst |
| Synkron startScanning | CLEANUP | Inkonsekvent felhantering |

Inga andra stabilitets- eller prestandaproblem identifierade. Efter dessa tre fixar är BLE-modulen fullt optimerad.

