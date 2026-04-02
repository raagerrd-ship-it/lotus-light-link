

## Fix pipeline-mätningen

### Problemanalys

Nuvarande mätning har ett grundläggande problem: `totalTickMs` mäter `bleEnd - tickStart`, men `bleEnd` sätts direkt efter `await sendToBLE()`. Problemet är att `writeValueWithoutResponse` returnerar när **OS-bufferten accepterar datat** — inte när det faktiskt sänts över BLE-radion. Därför visar pipelinen 6–8ms trots att hårdvaran behöver ~30ms per connection interval.

Dessutom: `smoothEnd` (rad 355) sätts **före** palett-logiken (rad 357–399), så `bleCallMs` inkluderar palett-beräkning — inte bara BLE.

### Vad som behöver fixas

**1. Flytta `smoothEnd`-mätpunkten** (`src/lib/engine/lightEngine.ts`)
- Flytta `const smoothEnd = performance.now()` till precis före BLE-anropet (efter palett + färgkalibrering), så `bleCallMs` verkligen bara mäter BLE-tiden.

**2. Lägg till "effective write interval"** (`src/lib/engine/bledom.ts`)
- Spara `performance.now()` vid varje lyckad write (`_lastWriteTime`).
- Beräkna `bleEffectiveIntervalMs = now - _lastWriteTime` — den **verkliga tiden mellan sändningar** till lampan.
- Skriv till `debugData.bleEffectiveIntervalMs`.

**3. Uppdatera debugStore** (`src/lib/ui/debugStore.ts`)
- Lägg till `bleEffectiveIntervalMs: number` (default 0).

**4. Visa i debug-panelen** (`src/components/DebugOverlay.tsx`)
- Ny rad under pipeline: `interval: 85ms` — den faktiska tiden mellan BLE-kommandon som lampan ser.
- Färgkoda: grön om nära tickMs, röd om >>tickMs (= många skippade ticks).
- **Detta värde** är det som ska styra adaptiv tick-rate — inte pipeline-latensen.

### Resultat

```text
pipeline: 8ms (ble 5ms)     ← hur lång tid koden tar
interval: 95ms              ← hur ofta lampan faktiskt uppdateras  ← NYT!
████████░░ [pipeline-bar]
```

Nu ser man tydligt: koden tar 8ms, men lampan uppdateras bara var 95:e ms. Om `interval` >> `tickMs` vet man att busy/delta-skips äter upp ticks. Det är **interval**-värdet som adaptiv tick-rate ska optimera mot.

