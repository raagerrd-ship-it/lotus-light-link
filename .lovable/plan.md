

## Plan: Tick-intervall slider i headern

### Vad

En temporär slider i headern (25–75 ms, 1 ms steg) som styr tick-workerns intervall i realtid. Visar aktuellt värde. Tas bort när sweet spot hittats.

### Ändringar

**1. `public/tick-worker.js`** — Lyssna på dynamiskt intervall via `postMessage`:
```js
self.onmessage = (e) => {
  if (e.data === 'start') { ... }
  else if (e.data === 'stop') { ... }
  else if (typeof e.data === 'number') {
    // Ändra intervall live
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => self.postMessage('tick'), e.data);
  }
};
```

**2. `src/components/MicPanel.tsx`** — Exponera worker-referensen så Index kan skicka nytt intervall:
- Lägg till prop `tickMs?: number`
- `useEffect` som skickar `worker.postMessage(tickMs)` vid ändring

**3. `src/pages/Index.tsx`** — Lägg till state + slider i headern:
- `const [tickMs, setTickMs] = useState(25)`
- En kompakt `<input type="range" min={25} max={75} step={1}>` med label `{tickMs}ms` i header-raden (bara när connected)
- Skicka `tickMs` som prop till `MicPanel`

### Placering i headern

Slidern läggs i header-baren mellan device-namn och knapparna — kompakt, synlig, lätt att nå.

