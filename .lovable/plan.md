

# BLE-modul: Stabilitetsanalys och åtgärder

## Identifierade problem

### 1. Timer-läcka i `withTimeout` (connect.ts:52-58)
`setTimeout` rensas aldrig vid lyckad resolve. Timern lever kvar och skapar en ohanterad rejection som kan krascha processen.

### 2. Reconnect använder gammalt peripheral-objekt (reconnect.ts:23)
`reconnectWithBackoff` tar emot det gamla peripheral-objektet och försöker `connectPeripheral(peripheral)` direkt. Efter disconnect kan det objektet vara ogiltigt. Bör använda `autoConnectSaved()` direkt istället för att dela upp i "direct retry" och "scan retry".

### 3. Disconnect-handler registreras EFTER device aktiveras (connect.ts:148-181)
`setDevice()` anropas på rad 149, men `peripheral.once('disconnect')` registreras på rad 160. Om disconnect sker i det fönstret missar vi eventet → zombie-device.

### 4. Keep-alive triggar aldrig reconnect (protocol.ts:63-82)
Om keep-alive misslyckas upprepade gånger loggas det bara — ingen disconnect/reconnect. Enheten kan hamna i zombieläge där `getDevice()` returnerar ett dött objekt.

### 5. HCI reset nollställer inte failure-räknaren (connect.ts:376-378)
Efter `resetHciAdapter()` fortsätter `consecutiveConnectFailures` att öka. Varje framtida misslyckat försök triggar ny HCI-reset, onödigt aggressivt.

### 6. `restartNobleHci` körs varje direktanslutning (connect.ts:206)
Lägger till 600ms+ (två 300ms-sleeps) även om adaptern redan är redo. Bör bara köras om adaptern inte är `poweredOn`.

### 7. `scan.ts` startar om bluetooth-tjänsten varje scan (scan.ts:37)
`systemctl restart bluetooth` vid varje scan är tungt och kan störa noble-tillståndet.

## Plan

### Steg 1: Fixa `withTimeout` timer-läcka
Använd `AbortController` eller rensa timern manuellt vid resolve:
```typescript
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS);
    }),
  ]);
}
```

### Steg 2: Flytta disconnect-handler före `setDevice`
Registrera `peripheral.once('disconnect')` **innan** `setDevice()` anropas.

### Steg 3: Förenkla reconnect — använd alltid `autoConnectSaved`
Ta bort fas 1 (direct retry med gammalt peripheral). Hela `reconnectWithBackoff` bör köra `autoConnectSaved()` med backoff. Inga stale-objekt.

### Steg 4: Keep-alive → proaktiv reconnect vid upprepade misslyckanden
Om keep-alive misslyckas 5+ gånger i rad → trigga disconnect + reconnect (samma logik som `sendToBLE` redan har).

### Steg 5: Nollställ failure-räknare efter HCI-reset
Lägg till `resetConsecutiveFailures()` efter lyckad `resetHciAdapter()`.

### Steg 6: Skippa `restartNobleHci` om adaptern redan är uppe
Kolla `getAdapterState() === 'poweredOn'` först i `nobleDirectConnect`. Skippa restart om redan redo.

### Steg 7: Ta bort `systemctl restart bluetooth` i scan.ts
Ersätt med enbart `stopNoble()` + kort delay. Bluetooth-tjänsten ska inte startas om vid varje scan.

## Teknisk sammanfattning

| Problem | Risk | Åtgärd |
|---------|------|--------|
| Timer-läcka | Ohanterad rejection → crash | Rensa timer |
| Stale peripheral i reconnect | Misslyckas alltid → onödig delay | Använd `autoConnectSaved` |
| Disconnect-handler race | Zombie-device | Flytta handler före `setDevice` |
| Keep-alive zombie | Device dött men ej detekterat | Proaktiv reconnect |
| HCI reset spam | Onödig power-cycle | Nollställ räknare |
| Onödig adapter-restart | +600ms per connect | Villkorlig restart |
| Bluetooth service restart | Tungt, störande | Ta bort |

Alla ändringar sker i `pi/src/ble/` — fyra filer berörs: `connect.ts`, `reconnect.ts`, `protocol.ts`, `scan.ts`.

