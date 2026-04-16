

# Spara BLE-metadata för direktanslutning utan scan

## Problem
Varje gång vi vill ansluta till en sparad enhet måste noble scanna i ~5 sekunder för att populera sin interna peripheral-cache. Detta är onödigt om vi redan vet enhetens adress och addressType.

## Vad som behöver sparas (utöver id/name/mac)
- **addressType** (`"public"` | `"random"`) — krävs för L2CAP
- **connectable** (boolean) — bra att veta
- **serviceUuids** (string[]) — för filtrering

## Teknisk plan

### 1. Utöka `selectDevice()` i discover.ts
När användaren väljer en enhet efter scan, spara hela noble-peripheralens metadata (inte bara id/name):
- Hämta peripheral-objektet från nobles cache via `noble._peripherals[id]`
- Extrahera `addressType`, `connectable`, `serviceUuids`
- Skicka med till `setSavedDevice()`

### 2. Uppdatera `setSavedDevice()` i state.ts
Lägg till fält för `addressType`, `connectable`, `serviceUuids` i persisterad state (localStorage via storage.ts). State.ts har redan stöd för detta — `SavedDeviceMetadata` och extra parametrar finns, men de fylls aldrig i från discover.ts.

### 3. Lägg till `nobleDirectConnect()` i discover.ts
Ny funktion som skapar ett peripheral-objekt direkt utan scan:
```
noble._bindings.connectAsync(savedAddress, savedAddressType)
```
Eller via nobles interna API. Om det misslyckas → fallback till nuvarande `nobleConnect()` med scan.

### 4. Uppdatera `autoConnectSaved()` 
Försök `nobleDirectConnect()` först. Om det misslyckas, fallback till `nobleConnect()` (scan + connect).

### Filer som ändras
- `pi/src/ble/discover.ts` — spara metadata vid select, ny directConnect-funktion
- `pi/src/ble/state.ts` — redan förberett, bara behöver fyllas i korrekt
- `pi/src/ble/scan.ts` — eventuellt spara addressType från bluetoothctl-output (om tillgängligt)
- `.lovable/memory/pi/ble/hybrid-discovery-strategy.md` — uppdatera med direktanslutningsflöde

### Risker
- Noble's interna API (`_bindings`, `_peripherals`) är ej dokumenterad och kan ändras mellan versioner
- Om addressType sparas fel → connection timeout → fallback till scan (säker degradering)

