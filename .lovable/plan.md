

## Fix: BLE-kön som orsakar 20–30 sekunders fördröjning

### Problemet

`sendToBLE` är `async` men **anroparen väntar inte** på att föregående write ska bli klar. Chrome köar varje `writeValueWithoutResponse`-anrop internt. Vid 20ms tick byggs det snabbt upp hundratals väntande writes i OS:ets Bluetooth-stack. När musiken pausar tar det 20–30 sekunder att dränera kön.

### Lösning: Non-reentrant guard + write-latency tracking

Lägg till en **in-flight guard** — om en BLE-write redan pågår, skippa nästa. Kön kan aldrig växa förbi 1 kommando. Plus latency-mätning i debug-overlayen.

```text
sendToBLE():
  ├─ _writeInFlight? → skip (NY räknare: bleSkipBusyCount)
  ├─ delta < 8? → skip
  ├─ _writeInFlight = true
  ├─ t0 = now()
  ├─ await write
  ├─ lat = now() - t0
  ├─ _writeInFlight = false
  └─ update debugData latency
```

### Filer

1. **`src/lib/engine/bledom.ts`**
   - Lägg till `let _writeInFlight = false` — sätts `true` före write, `false` efter
   - Om `_writeInFlight` vid inträde → `debugData.bleSkipBusyCount++; return`
   - Ta bort throttle-checken (den behövs inte längre — in-flight guard + delta-gate räcker)
   - Mät write-latency: `performance.now()` före/efter, spara i `debugData`

2. **`src/lib/ui/debugStore.ts`**
   - Lägg till: `bleSkipBusyCount`, `bleWriteLatMs`, `bleWriteLatAvgMs`

3. **`src/components/DebugOverlay.tsx`**
   - Visa latency med färgkodning (grön <15ms, gul 15–30ms, röd >30ms)
   - Visa busy-skip i stats-raden

4. **`src/components/MicPanel.tsx`**
   - Nollställ `bleSkipBusyCount` vid låtbyte

### Varför detta löser 20–30s-fördröjningen

Idag: tick → fire write (don't await) → tick → fire write → ... → 500 writes i kö
Efter: tick → fire write → tick → redan in-flight, skip → ... → max 1 write i kö

Lampan reagerar omedelbart på paus eftersom det aldrig finns mer än **ett enda kommando** i Chromes BLE-buffert.

