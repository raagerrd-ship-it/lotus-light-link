

# Auto-reconnect med getDevices() + watchAdvertisements()

## Vad
Appen försöker automatiskt återansluta till en tidigare parad BLEDOM-enhet vid sidladdning — utan att visa webbläsarens enhetsväljare. Om enheten inte hittas inom några sekunder visas connect-skärmen som vanligt.

## Ändringar

### 1. `src/lib/bledom.ts` — ny funktion `autoReconnect()`

```typescript
export async function autoReconnect(): Promise<BLEConnection | null> {
  const nav = navigator as any;
  if (!nav.bluetooth?.getDevices) return null;

  const devices = await nav.bluetooth.getDevices();
  const saved = getLastDevice();
  const target = devices.find((d: any) => d.id === saved?.id) ?? devices[0];
  if (!target) return null;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      target.removeEventListener('advertisementreceived', onAdvert);
      resolve(null);
    }, 5000);

    const onAdvert = async () => {
      clearTimeout(timeout);
      target.removeEventListener('advertisementreceived', onAdvert);
      try {
        const conn = await connectToDevice(target);
        resolve(conn);
      } catch { resolve(null); }
    };

    target.addEventListener('advertisementreceived', onAdvert);
    target.watchAdvertisements({ signal: AbortSignal.timeout(5000) }).catch(() => resolve(null));
  });
}
```

### 2. `src/pages/Index.tsx` — anropa vid mount

Lägg till en `useEffect` som körs en gång vid mount:
- Sätter `reconnecting = true`
- Anropar `autoReconnect()`
- Om lyckas → `finishConnect(conn)`
- Om misslyckas → `reconnecting = false` (visar connect-skärmen)

Kommentaren "No auto-reconnect" tas bort.

### 3. `src/vite-env.d.ts` — lägg till typdeklarationer

Lägg till `getDevices()` och `watchAdvertisements()` i Bluetooth-typerna.

---

Tre filer, ingen beteendeändring om webbläsaren saknar stöd (graceful fallback till manuell anslutning).

