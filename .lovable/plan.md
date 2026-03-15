

## Plan: Minska GATT-fel + Förbättra debug-overlay

### Problem
1. **err:24 är kumulativt** — räknaren nollställs aldrig, så den bara växer. Svårt att veta om felen är aktiva eller gamla.
2. **Tick-worker kör var 25ms (40fps)** men GATT-skrivningar tar ibland 10-30ms+. Om en skrivning misslyckas finns ingen backoff — nästa tick försöker direkt igen, vilket kan skapa en kaskad av fel.
3. **Vid reconnect** nollställs aldrig felräknaren.

### Ändringar

#### 1. `src/lib/bledom.ts` — Robustare BLE-lager

- **Reset felräknare vid `setActiveChar`** — ny anslutning = ren start.
- **Error backoff**: Efter ett GATT-fel, sätt `_writing = true` i 100ms (blockerar nya skrivningar). Detta ger BLEDOM-stacken tid att återhämta sig istället för att hamra med nya försök.
- **Ändra `BleWriteStats`**: Lägg till `errorsSinceReset` (nollställs var 2:a sekund, som `writesPerSec`) samt behåll `errorCount` som total. Debug-overlayn kan visa "err/s" istället för kumulativt.

#### 2. `src/components/DebugOverlay.tsx` — Tydligare felvisning

- Visa `err/s` (fel per sekund) istället för kumulativt `err:24`.
- Visa senaste felmeddelande som truncerad text vid >0 fel.
- Grön "0 err" när inga aktiva fel, röd pulsande vid aktiva fel/s.

### Tekniska detaljer

```text
tick-worker (25ms)
    │
    ▼
sendToBLE() → _pendingColor = [r,g,b]
    │
    ├── _writing? → skip (drop)
    ├── _backoffUntil > now? → skip (backoff)  ← NYTT
    │
    └── _flush()
         ├── success → _writing=false, callback
         └── error → _errorCount++
                     _backoffUntil = now + 100ms  ← NYTT
                     _writing=false
```

`BleWriteStats` utökas:
- `errorsPerSec: number` — rullande fel/s (nollställs var 2s)
- `errorCount` — total sedan senaste `setActiveChar`

DebugOverlay visar:
- `39w/s` (som nu)
- `0 err/s` (grön) eller `3 err/s` (röd, pulsande)
- Vid err>0: senaste felmeddelande i truncerad text

