
Användaren vill att jag tittar tillbaka på äldre versioner av projektet — innan vi delade upp motor och UI — för att se hur BLE-anslutningen fungerade då, och jämföra med dagens implementation som inte fungerar tillförlitligt.

Plan:
1. Använd `trajectory_observability--get_trajectory_events` för att hitta äldre commits/messages från tiden då BLE fungerade i webbläsaren (Web Bluetooth API i React-appen).
2. Titta specifikt på:
   - Hur `navigator.bluetooth.requestDevice` användes
   - GATT discovery-sekvensen
   - Vilka services/characteristics som användes (FFF0/FFF3)
   - Write pipeline (writeWithoutResponse vs write)
   - Reconnect-strategin
3. Jämför med dagens `pi/src/ble/connect.ts`, `protocol.ts`, `adapter.ts` för att hitta:
   - Saknad logik (t.ex. service discovery-ordning, write-typ, timing)
   - Annorlunda paketformat
   - Annorlunda connect-sekvens
4. Sammanställ konkreta lärdomar och föreslå patchar till nuvarande Pi-koden.

# Vad jag ska göra

**Steg 1 — Arkeologi**
- Hämta äldre trajectory events för att hitta originalimplementationen av BLE i webbläsaren (Web Bluetooth).
- Läs gamla versioner av filer som `src/lib/engine/ble.ts` eller liknande som fanns innan uppdelningen.

**Steg 2 — Jämförelseanalys**
Jämför följande aspekter mellan gammal (web) och ny (Pi/noble) implementation:
| Aspekt | Web Bluetooth (gammal) | noble (nu) |
|---|---|---|
| Discovery | requestDevice filter | scan/direct connect |
| Service UUID | fff0 | fff0 |
| Char UUID | fff3 | fff3 |
| Write-typ | writeValueWithoutResponse | writeAsync(buf, true) |
| Connect-sekvens | gatt.connect → getPrimaryService → getCharacteristic | connectAsync → discoverAllServicesAndCharacteristicsAsync |
| Adapter init | N/A (browser) | initAdapter + waitForPoweredOn |

**Steg 3 — Identifiera rotorsaken**
Baserat på de senaste loggarna (`Adapter not ready: poweredOn`, `Power cycle FAILED`) misstänker jag:
- `bluetoothctl` är inte tillgängligt eller saknar rättigheter i systemd-sandboxen → Power cycle FAILED
- noble's interna state-flagga blir aldrig `poweredOn` trots caps-override → `waitForAdapter` returnerar false
- Vi behöver **helt skippa** `waitForPoweredOnAsync` när caps är OK och bara köra `connectAsync` direkt

**Steg 4 — Föreslå konkreta ändringar i `pi/src/ble/`**
1. **adapter.ts**: Ta bort `waitForPoweredOnAsync`-anropet helt när `processHasBtCaps()` är true. Lita 100% på caps-overriden.
2. **connect.ts**: Ta bort `waitForAdapter`-checken före `connectAsync` — låt noble själv felhantera om adaptern inte är redo.
3. **adapter.ts**: Ta bort hela `bluetoothctl`-power-cycle-logiken (den fungerar inte i sandboxen) och ersätt med `hciconfig hci0 reset` som vi redan vet fungerar (samma som scan-knappen använder).
4. Eventuellt: använd `writeWithoutResponse` som standard (snabbare, matchar gamla web-implementationen).

# Tekniska detaljer

- Trajectory-tools låter mig se commit-historik och äldre filinnehåll
- Jag behöver bekräfta vilka filer som fanns under `src/lib/engine/` eller `src/lib/ble/` innan uppdelningen
- Det är möjligt att den gamla web-versionen aldrig hade det här caps/poweredOn-problemet eftersom Web Bluetooth API:t hanterar adaptern internt — men vi kan ändå lära oss av paketformat, write-typ och GATT-sekvens

# Resultat
Efter utforskningen presenterar jag en kort lista med 2–4 konkreta patchar att applicera på `pi/src/ble/adapter.ts` och `pi/src/ble/connect.ts`, baserat på vad som faktiskt fungerade i den gamla versionen.

# Frågor att besvara innan vi kör
Inga — jag har tillräckligt med kontext för att börja gräva i historiken så snart du godkänner planen.
