# LightEngine — Audio-reactive BLE light controller

A portable, framework-agnostic engine that listens to microphone input, analyzes frequency bands in real-time, and drives BLE LED strips (BLEDOM protocol) with brightness and color synchronized to music.

## Quick start

```bash
# Copy these into your project:
src/lib/engine/    # All engine files
public/tick-worker.js  # Background timer (keeps running when tab is hidden)
```

```typescript
import { LightEngine, connectBLEDOM } from './engine';

// 1. Connect to a BLE LED strip
const { device, characteristic } = await connectBLEDOM();

// 2. Create and configure the engine
const engine = new LightEngine();
engine.setChar(characteristic);
engine.setColor([255, 80, 0]); // RGB base color

// 3. Listen for ticks (~8Hz)
engine.onTick((data) => {
  console.log(`Brightness: ${data.brightness}%`, data.color);
});

// 4. Start (requests microphone access)
await engine.start();

// Later...
engine.stop();
```

## API

### `LightEngine`

| Method | Description |
|---|---|
| `start()` | Init microphone, audio pipeline, and tick loop |
| `stop()` | Release all resources |
| `setColor(rgb)` | Set base RGB color (e.g. from album art) |
| `setVolume(vol)` | Current playback volume (enables AGC volume compensation) |
| `setPlaying(bool)` | `true` = active mode, `false` = idle color |
| `setChar(char)` | Set BLE characteristic for output |
| `setTickMs(ms)` | Tick interval (default 125ms = 8Hz) |
| `resetAgc()` | Reset gain control (call on track change) |
| `onTick(callback)` | Subscribe to tick data. Returns unsubscribe function |

### `TickData` (received in `onTick`)

```typescript
{
  brightness: number;        // 0-100, final brightness sent to BLE
  color: [r, g, b];          // Calibrated RGB
  baseColor: [r, g, b];      // Base color before brightness scaling
  bassLevel: number;          // Raw bass RMS
  midHiLevel: number;         // Raw mid+hi RMS
  rawEnergyPct: number;       // Energy before dynamics processing
  isPunch: boolean;           // True if punch-white threshold exceeded
  bleColorSource: 'normal' | 'idle';
  micRms: number;             // Smoothed overall RMS
  isPlaying: boolean;
  timings: { rmsMs, smoothMs, bleCallMs, totalTickMs };
}
```

### BLE connection

```typescript
import { connectBLEDOM, autoReconnect } from './engine';

// Manual connect (shows browser picker)
const conn = await connectBLEDOM();

// Auto-reconnect to last known device
const conn = await autoReconnect(abortSignal, (status) => {
  console.log(status.phase, status.attempt);
});
```

### Calibration

All calibration is stored in `localStorage` and loaded automatically. Key parameters:

| Parameter | Default | Description |
|---|---|---|
| `attackAlpha` | 0.3 | How fast brightness rises (0.05–1.0) |
| `releaseAlpha` | 0.025 | How fast brightness falls (0.005–1.0) |
| `dynamicDamping` | -1.0 | Negative = expand contrast, positive = compress |
| `bassWeight` | 0.7 | Bass influence on brightness (0–1) |
| `hiShelfGainDb` | 6 | High-frequency mic compensation |
| `punchWhiteThreshold` | 0 | Brightness % above which color → white (0 = off) |
| `volCompensation` | 80 | How much volume changes affect AGC (0–100%) |

```typescript
import { getCalibration, saveCalibration } from './engine';

const cal = getCalibration();
cal.bassWeight = 0.9;
saveCalibration(cal);
```

#### Cloud persistence (optional)

The engine only uses `localStorage`. To add cloud sync, install a hook:

```typescript
import { setCloudSaveHook } from './engine';

setCloudSaveHook((deviceName, patch, createNew) => {
  // Your cloud save logic here
  myApi.saveCalibration(deviceName, patch);
});
```

### AGC (Automatic Gain Control)

The engine uses a "learn-then-lock" strategy:

1. On `resetAgc()`, saved levels are scaled by current/saved volume ratio
2. For 20 seconds, AGC learns the signal range (fast attack α=0.15)
3. After 20s, levels are locked for stable brightness
4. Volume changes >5 units trigger a new 20s learning window

### Presets

```typescript
import { getPresets, savePresetCalibration, setActivePreset } from './engine';

const presets = getPresets(); // { Lugn, Normal, Party, Custom }
setActivePreset('Party');
```

## Architecture

```
engine/
├── lightEngine.ts      ← Main orchestrator (tick loop)
├── bledom.ts           ← BLE protocol (BLEDOM 9-byte packets)
├── bleStore.ts         ← Connection state store
├── audioAnalysis.ts    ← FFT → bass/mid-hi band split
├── agc.ts              ← Automatic gain control state machine
├── brightnessEngine.ts ← Smoothing + dynamics processing
├── lightCalibration.ts ← Settings persistence (localStorage)
└── index.ts            ← Barrel export
```

## Requirements

- Browser with Web Bluetooth API (Chrome/Edge)
- Microphone access
- BLEDOM-compatible LED strip
- `tick-worker.js` served from `/tick-worker.js`
