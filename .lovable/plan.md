

## Debugging och optimering av hela latenskedjan

### Identifierade flaskhalsar

**1. tick-worker intervall (50ms) — begränsar responsivitet**
Arbetaren tickar var 50ms, men BLE-schedulern tillåter en write per 50ms. Om ticken och BLE-sloten inte synkar perfekt kan det bli upp till 100ms fördröjning. Sänk tick till 25–30ms så att BLE-schedulern alltid har färsk data.

**2. Canvas-ritning i tick-loopen blockerar**
`drawIntensityChart` ritar 120 samples med linjer + cirklar synkront i varje tick-callback. Detta blockerar huvudtråden ~1-3ms per tick. Flytta till `requestAnimationFrame` istället — frikoppla chart-rendering från audio-analys.

**3. `getLastDevice()` läser localStorage varje render**
`Index.tsx` rad 34: `const lastDevice = getLastDevice()` körs vid varje re-render och läser/parsear localStorage. Bör cachas i state/ref.

**4. React ref-varningar → onödiga reconciliation-kostnader**  
Konsolen visar "Function components cannot be given refs" för `Index` och `MicPanel`. Detta indikerar att en ref passas till en funktionskomponent som inte stöder det — kan orsaka extra arbete i Reacts reconciler.

**5. `extractPalette` blockerar huvudtråden**
Canvas-baserad pixelanalys (64×64 bild, k-means-klustring) körs synkront på huvudtråden vid låtbyte. Kan blockera 5-20ms under analys.

### Plan

| # | Åtgärd | Fil | Effekt |
|---|--------|-----|--------|
| 1 | Sänk tick-worker från 50ms → 25ms | `public/tick-worker.js` | Halverar worst-case input-latens |
| 2 | Frikoppla chart-ritning till rAF | `src/components/MicPanel.tsx` | Avblockerar tick-callback |
| 3 | Cacha `getLastDevice()` i state | `src/pages/Index.tsx` | Eliminerar localStorage-läsning per render |
| 4 | Fixa ref-varningar (ta bort ref från Index/MicPanel) | `src/pages/Index.tsx` | Renare reconciliation |
| 5 | Kör `extractPalette` med `requestIdleCallback` eller i en microtask | `src/pages/Index.tsx` | Undvik att blockera tick-loop vid låtbyte |
| 6 | Lägg till end-to-end latens-mätning i DebugOverlay | `src/components/DebugOverlay.tsx` + `MicPanel` | Synlig mätning: mic→BLE-write tid |

### Tekniska detaljer

**tick-worker.js**: Ändra `setInterval(() => ..., 50)` → `setInterval(() => ..., 25)`.

**MicPanel.tsx — frikopplad chart**:
- Spara senaste sample i ref istället för att rita direkt i worker-callback
- Starta en separat `requestAnimationFrame`-loop som ritar chart från ref-datan
- Tick-callbacken gör bara: RMS-beräkning → smoothing → BLE-kommandon → push sample till ref

**Index.tsx — cacha lastDevice**:
```typescript
const [lastDevice] = useState(() => getLastDevice());
```

**Index.tsx — ref-fix**: Identifiera var ref passas till Index/MicPanel och ta bort eller wrappa med `forwardRef`.

**Latens-mätning**: Exponera `lastTickToWriteMs` från bledom.ts (tid från `_flush()` anrop till faktisk `writeValueWithoutResponse` completion), visa i DebugOverlay.

