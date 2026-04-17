
## Plan: Ren noble-scan, ta bort hcitool

### 1. `pi/src/ble/scan.ts` — full rewrite
Ersätt hela hcitool-logiken med noble:
- Ta bort `execFileSync`, `parseHcitoolScan`, `scanWithHcitool`
- Importera `getNoble()` från `state.ts` (eller motsvarande — verifierar exakt API)
- Vänta på `poweredOn` (timeout om adapter är `unknown` → returnera tom lista + tydligt felmeddelande)
- `noble.startScanningAsync([], true)` — alla services, allow duplicates för RSSI
- Lyssna på `discover`-event → bygg `DiscoveredDevice[]` (id, name, rssi)
- Efter `timeoutMs`: `noble.stopScanningAsync()`, ta bort lyssnare, returnera resultat
- Behåll `isNobleScanActive()`-guarden (om connect-flödet redan scannar)
- Behåll `lastScanResults` + `isScanning()` API:t oförändrat
- Behåll loggning via `logConnectionEvent`

### 2. `pi/setup-lotus.sh` — återställ
Ta bort hela `setcap`-blocket jag lade in (raderna kring "1b. Sätt capabilities på hcitool-binären"). Tillbaka till bara `rfkill unblock` + systemd-fix.

### 3. `pi/scripts/ble-scan-debug.sh`
Lämnar orört — fortfarande användbart som diagnostikverktyg manuellt på Pi:n även om engine inte använder hcitool.

### 4. Memory
Inget behöver uppdateras — `mem://pi/ble/hybrid-discovery-strategy` beskriver redan exakt detta flöde. scan.ts kommer äntligen matcha memory.

### Verifiering före implementation
Innan jag skriver, läser jag:
- `pi/src/ble/state.ts` — för rätt noble-accessor och adapterState-API
- `pi/src/ble/connect.ts` — för `isNobleScanActive` och säkerställa ingen race med connect-flödets scan
- `pi/src/ble/types.ts` — för `DiscoveredDevice`-shape

### Risker
- Om noble fastnar i `unknown` på Pi:n (känt problem från memory `noble-compatibility`) får vi 0 enheter. Men det var ju samma situation som drev hcitool-vägen från början. Lösning: tydlig felflagga i UI + förlita oss på att `adapter.ts` redan har retry-logik för att få noble till `poweredOn`.

Godkänn så implementerar jag.
