

## Deduplisera BLE-kommandon

### Problem
Varje tick skickar ett BLE-paket oavsett om färg/ljusstyrka ändrats — detta köar upp identiska kommandon och skapar upplevd tröghet.

### Lösning
Lägg till en enkel jämförelse i `sendToBLE()` som sparar de senast skickade värdena (R, G, B efter skalning) och hoppar över `writeValueWithoutResponse` om paketet är identiskt.

### Teknisk plan

**Fil: `src/lib/engine/bledom.ts`**

1. Lägg till tre modulvariabler: `_lastR`, `_lastG`, `_lastB` (alla initierade till `-1` så första skicket alltid går igenom).
2. I `sendToBLE()`, efter beräkning av `_colorBuf[4-6]` och `_brightOnlyBuf[3]`, jämför med sparade värden. Om alla tre RGB-bytes OCH brightness-byten är identiska → `return` direkt utan att skicka.
3. Uppdatera sparade värden efter lyckad skickning.
4. Lägg till en `resetLastSent()` export som sätter alla till `-1` — anropas vid device-reconnect så att första kommandot efter återanslutning alltid skickas.

Inga andra filer behöver ändras — dedupliceringen sker transparent i det befintliga anropet.

