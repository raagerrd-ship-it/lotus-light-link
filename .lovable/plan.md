

# Latensanalys – Baspuls

Koden är redan väl optimerad. Här är en genomgång av alla latensskikt och vad som kan förbättras ytterligare:

## Nuvarande latenskällor (uppskattning)

```text
Källa                  Nuvarande    Optimalt     Åtgärd
─────────────────────  ──────────   ─────────    ──────────────
AudioContext latency   ~5-20ms      ~2-5ms       Kan tvinga lägre buffertstorlek
AnalyserNode fftSize   128 samples  128          ✅ Redan minimalt
BiquadFilter           ~0ms         ~0ms         ✅ Ingen extra latens
rAF loop               ~16ms        ~16ms        ✅ Bästa möjliga i browser
BLE throttle           40ms         30ms         Kan sänkas något
Date.now()             ~0ms         ~0ms         ✅ OK
BPM: sort+filter       O(n log n)   O(n)         Marginellt, bara vid onset
```

## Förbättringar att göra

### 1. Tvinga lägsta möjliga AudioContext-buffert
`latencyHint: "interactive"` är bra, men vi kan även sätta en explicit `sampleRate` på 8000 Hz. Lägre sample rate = mindre data per frame = snabbare analyser-fyllnad. Dessutom behöver vi bara basfrekvenser (30-200Hz) så 8000Hz räcker gott.

### 2. Sänk BLE-throttle från 40ms till 30ms
BLEDOM klarar ~33Hz utan problem. Minskar worst-case BLE-latens med 10ms.

### 3. Använd `performance.now()` istället för `Date.now()`
`performance.now()` har sub-millisekund-precision och är snabbare att anropa i tight loops.

### 4. Cacha `currentColor` i ref istället för att läsa från closure
`currentColor` i effect-loopen orsakar att hela effecten re-mountas vid färgbyte. Bör läsas från en ref så att loopen aldrig avbryts.

### 5. Ta bort `currentColor` från useEffect-dependency
Den nuvarande koden avbryter och startar om rAF-loopen vid varje färgbyte, vilket ger en kort "glitch". Med en ref-baserad approach behöver loopen aldrig startas om.

### 6. Pre-allokera BLE-kommandobuffertar
`sendBrightness` och `sendColor` skapar nya `Uint8Array` vid varje anrop. Pre-allokera dessa en gång och bara uppdatera byten som ändras.

## Sammanfattning av ändringar

- `MicPanel.tsx`: Sänk sampleRate till 8000, BLE-throttle till 30ms, `performance.now()`, flytta `currentColor` till ref, ta bort från effect-deps
- `bledom.ts`: Pre-allokera buffertar i `sendColor`/`sendBrightness` (valfritt, minimal vinst)

Total uppskattad latensförbättring: **~15-25ms** (främst från lägre sampleRate + snabbare BLE-rate + ingen loop-restart vid färgbyte).

