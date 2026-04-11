

## Diagnostik-endpoint + live debug-vy med OK-ranges

### Vad vi bygger
En realtids-diagnostikpanel som visar exakt var i pipelinen ljuset tappas — från rå mikrofonsignal till slutlig BLE-output. Varje mätvärde visas med en färgkodad indikator (gron/gul/rod) baserad pa definierade OK-ranges. Allt ar fire-and-forget — inga `await` i hot path.

### Arkitektur

Diagnostik-data samlas genom att mutera ett statiskt objekt i `tickInner()` (zero-alloc, inget await, inget som blockerar). API-endpointen laser bara av objektet — ingen berakning vid request-tid.

```text
tickInner() ──mutate──> _diagSnapshot (static obj)
                              │
GET /api/diagnostics ─────read┘  (pure read, no lock)
```

### Fil 1: `pi/src/piEngine.ts`

Lagg till ett statiskt diagnostik-objekt som muteras i slutet av `tickInner()`:

```typescript
// Static diagnostic snapshot — mutated in-place, zero-alloc
const _diag = {
  rawRms: 0,           // OK: 0.01–0.5
  bassRms: 0,          // OK: 0.01–0.3
  midHiRms: 0,         // OK: 0.01–0.2
  agcMax: 0,            // OK: 0.02–1.0
  agcQuietTicks: 0,     // OK: 0 (>50 = tyst)
  energyNorm: 0,        // OK: 0.2–0.8
  dynamicCenter: 0,     // OK: 0.3–0.7
  onsetBoost: 0,        // OK: 0–0.22
  brightnessPct: 0,     // OK: 30–100
  bleScaleRaw: 0,       // OK: 0.1–1.0
  finalR: 0, finalG: 0, finalB: 0,
  tickCount: 0,
  lastTickUs: 0,        // OK: <500
};
```

Exponera via `getDiagnostics()` (returnerar referens, ingen kopia).

I `tickInner()`, efter BLE-send, mutera `_diag` med aktuella varden. Ingen allokering, ingen await.

### Fil 2: `pi/src/configServer.ts`

Nytt endpoint:

```typescript
app.get('/api/diagnostics', (_req, res) => {
  const diag = engine.getDiagnostics();
  const cal = engine.getCalibration();
  res.json({
    pipeline: diag,
    ble: bleStats,
    calibration: {
      dimmingGamma: getDimmingGamma(),
      releaseAlpha: cal.releaseAlpha,
      dynamicDamping: cal.dynamicDamping,
      smoothing: cal.smoothing,
      brightnessFloor: cal.brightnessFloor,
      perceptualCurve: cal.perceptualCurve,
      transientBoost: cal.transientBoost,
    },
    ranges: {
      rawRms:         { ok: [0.01, 0.5],  warn: "0 = ingen signal" },
      agcMax:         { ok: [0.02, 1.0],  warn: "<0.02 = tyst rum" },
      energyNorm:     { ok: [0.2, 0.8],   warn: "<0.1 = for tyst, >0.95 = clipping" },
      dynamicCenter:  { ok: [0.3, 0.7],   warn: "fast vid 0 eller 1 = problem" },
      brightnessPct:  { ok: [30, 100],     warn: "<20 = svagt ljus" },
      bleScaleRaw:    { ok: [0.1, 1.0],    warn: "<0.05 = nast osynligt" },
      bleWriteLatMs:  { ok: [0, 15],       warn: ">20 = for langsam BLE" },
      bleSkipBusy:    { ok: [0, 50],       warn: ">200 = BLE halkar efter" },
      lastTickUs:     { ok: [0, 500],      warn: ">1000 = motorn ar overbelastad" },
    }
  });
});
```

### Fil 3: `src/pages/PiMobile.tsx`

Ny diagnostik-sektion (togglas med en knapp). Pollar `/api/diagnostics` var 500ms. Visar en kompakt tabell med:

| Varde | Aktuellt | OK-range | Status |
|-------|----------|----------|--------|
| rawRms | 0.042 | 0.01–0.5 | 🟢 |
| energyNorm | 0.05 | 0.2–0.8 | 🔴 |
| brightnessPct | 12 | 30–100 | 🔴 |
| bleWriteLatMs | 8.2 | 0–15 | 🟢 |
| ... | ... | ... | ... |

Fargkodning:
- **Gron**: inom OK-range
- **Gul**: nara grans (inom 20% utanfor)
- **Rod**: utanfor range

Inga andra filer paverkas. Allt ar bakatikompatibelt.

### Sammanfattning av andringar
1. **`pi/src/piEngine.ts`** — lagg till `_diag` objekt + mutera i `tickInner()` + `getDiagnostics()` + `getCalibration()`
2. **`pi/src/configServer.ts`** — `GET /api/diagnostics` med ranges
3. **`src/pages/PiMobile.tsx`** — diagnostik-panel med fargkodade OK-ranges

