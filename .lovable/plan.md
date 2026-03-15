

# Multi-BLE: Styra flera LED-remsor från en flik

## Nuläge

Idag finns en **global singel-char** (`_char` i `bledom.ts`) — bara en BLE-enhet åt gången. `LightEngine` har också en enda `this.char`. Hela kedjan är 1:1.

## Arkitektur

Ändringen sker i tre lager:

### 1. Engine-lagret (`bledom.ts`)
Ersätt den globala `_char` med en **Set av characteristics**. `sendToBLE` itererar och skriver till alla parallellt.

```text
_chars: Set<BluetoothRemoteGATTCharacteristic>

addActiveChar(char)    ← lägger till
removeActiveChar(char) ← tar bort
clearAllChars()        ← nollställer

sendToBLE(r,g,b,bright) → Promise.allSettled(_chars → write)
```

### 2. LightEngine (`lightEngine.ts`)
Byt `this.char` till `this.chars: Set<...>`. Ny metod `addChar(char)` / `removeChar(char)`. Tick-loopen kontrollerar `this.chars.size > 0` istället för `this.char`.

### 3. UI-lagret (`Index.tsx`)
- `connection` → `connections: BLEConnection[]` (array-state)
- "Lägg till enhet"-knapp (Bluetooth+ ikon) visas **efter** första anslutningen
- Header visar antal anslutna enheter, t.ex. "ELK × 2" eller en liten badge
- `finishConnect` pushar till arrayen istället för att ersätta
- Disconnect-hantering tar bort just den enheten från arrayen
- `MicPanel` får alla chars (engine hanterar multi internt)

### 4. BleStore (`bleStore.ts`)
Ändra till att hålla en array: `BLEConnection[]`.

## Detaljerade ändringar

| Fil | Ändring |
|-----|---------|
| `bledom.ts` | `_char` → `_chars: Set`, `addActiveChar`, `removeActiveChar`, `sendToBLE` skriver till alla |
| `lightEngine.ts` | `char` → `chars: Set`, `addChar`/`removeChar`, idle/tick skriver via alla |
| `bleStore.ts` | `_connection` → `_connections: BLEConnection[]`, `addBleConnection`/`removeBleConnection` |
| `Index.tsx` | Array-state, "Lägg till"-knapp, per-enhet disconnect, uppdaterad header |
| `MicPanel.tsx` | Prop `char` → `chars`, skickar alla till engine |
| `index.ts` (barrel) | Exportera nya funktioner |

## UI-skiss

```text
┌─────────────────────────────────┐
│ 🔵 ELK-BLEDOM  [+]  A B C  ⚙ ⏻│   ← [+] lägger till fler
│ 🔵 MELK-02          (badges)   │   ← visas under första
└─────────────────────────────────┘
```

Alternativt en kompakt badge: `🔵 2 enheter [+]`

## Begränsningar
- Web Bluetooth tillåter max ~7 simultana GATT-anslutningar (browser-beroende)
- Varje `writeValueWithoutResponse` körs parallellt via `Promise.allSettled` — om en enhet tappar anslutning påverkas inte övriga
- Latens ökar marginellt (~1-2ms per extra enhet)

