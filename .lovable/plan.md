

# Wrappa handleConnect och handleReconnect i useCallback

Enkel refaktor — wrappa båda funktionerna i `useCallback` med `finishConnect` som enda dependency (samma mönster som `handleColorSelect`).

### Ändringar i `src/pages/Index.tsx` (rad 130–154)

```typescript
const handleConnect = useCallback(async (scanAll = false) => {
  setConnecting(true);
  setError(null);
  try {
    const conn = await connectBLEDOM(scanAll);
    await finishConnect(conn);
  } catch (e: any) {
    setError(e.message || "Kunde inte ansluta");
  } finally {
    setConnecting(false);
  }
}, [finishConnect]);

const handleReconnect = useCallback(async () => {
  setReconnecting(true);
  setError(null);
  try {
    const conn = await connectBLEDOM(false);
    await finishConnect(conn);
  } catch (e: any) {
    setError(e.message || "Kunde inte återansluta");
  } finally {
    setReconnecting(false);
  }
}, [finishConnect]);
```

En fil, inga b