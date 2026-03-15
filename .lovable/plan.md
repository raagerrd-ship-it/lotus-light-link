

## Enhetligt 50ms tick-intervall (20 fps)

**Idé:** Ändra tick-workern från 25ms → 50ms. Varje tick = 1 ljud-analys + 1 BLE-write + 1 chart-sample. Inget separat throttle behövs — allt synkas naturligt.

### Ändringar

**1. `public/tick-worker.js`** — Ändra intervall från 25 till 50:
```javascript
intervalId = setInterval(() => self.postMessage('tick'), 50);
```

**2. `src/lib/bledom.ts`** — BLE min-floor redan 50ms, men `_flush()`-logiken har en timer-baserad throttle som nu blir onödig. Vi kan behålla den som en säkerhetsgräns (den matchar redan 50ms), så inget behöver ändras här.

**3. `src/components/MicPanel.tsx`** — Chart-sampling sker i `onBleWrite`-callbacken. Eftersom varje tick nu är exakt en BLE-write behöver vi ingen separat throttle — varje callback = 1 sample = 20 fps.

**4. `src/components/CalibrationOverlay.tsx`** — Uppdatera `CHART_LEN`-kommentar: 90 samples vid 20fps = ~4.5s historik.

### Sammanfattning

| Före | Efter |
|------|-------|
| Worker: 25ms (40 ticks/s) | Worker: 50ms (20 ticks/s) |
| BLE throttlar bort varannan tick | Varje tick → 1 BLE-write |
| Chart behöver separat throttle | 1 tick = 1 sample, naturligt 20fps |

En enda ändring i tick-worker.js löser allt. Resten är kommentar-uppdatering.

