

## BLE-modul: Sista stabilitetsfixen

### Problem: Dubbel reconnect vid proaktiv disconnect

I `protocol.ts` (både keep-alive och write-failure-pathen):
1. `setDevice(null)` + `disconnectAsync()` + `_triggerReconnect()` körs i sekvens
2. Men `disconnectAsync()` triggar disconnect-eventet i `connect.ts` som OCKSÅ kör `_reconnectWithBackoff()`
3. Resultat: två parallella reconnect-loopar

### Åtgärd

**`protocol.ts`** — Ta bort disconnect-listenern INNAN `disconnectAsync()` anropas, i båda ställena (keep-alive rad ~86 och write-failure rad ~177):

```typescript
// Before disconnectAsync — prevent double reconnect
periph.removeAllListeners('disconnect');
stopKeepAlive();
setDevice(null);
resetLastSent();
try { await periph.disconnectAsync(); } catch {}
if (_triggerReconnect) _triggerReconnect(periph, name);
```

Detta säkerställer att bara EN reconnect-loop startas — den från protocol.ts som har kontext om varför disconnecten skedde.

### Berörda filer
- `pi/src/ble/protocol.ts` — 2 ställen: keep-alive (rad ~85-91) och write-failure (rad ~174-183)

### Redan fixat (från planen)
- ✅ Död `_nobleHciReleased`-branch borttagen
- ✅ GATT fallback array-destructuring fixad
- ⚠️ Synkron `startScanning` i nobleConnect — medvetet behållen (kan inte `await` i Promise executor)

### Sammanfattning
Efter denna fix finns inga fler identifierade stabilitets- eller korrekthetsproblem i BLE-modulen.

