

## Audit: Onödiga timers och resurskonsumenter

### Hittade problem

**1. NowPlayingBar — rAF 60fps för progressbar (onödig)**
`NowPlayingBar.tsx` kör `requestAnimationFrame` i en oändlig loop bara för att uppdatera en progressbar-bredd. 60fps för en 2px bar som knappt rör sig — helt onödig. Bör sänkas till ~4fps via `setTimeout` eller CSS-animation.

**2. MicPanel rAF — kör vid paus (onödig GPU-last)**
`MicPanel.tsx` rad 286-357: rAF-loopen körs alltid, även vid paus. Den hoppar chart-ritning men kör fortfarande:
- Crossfade-math varje frame
- Sun DOM-manipulation (`boxShadow`, `background`, `transform`) varje frame
- Palette-rotation-logik

De tunga `boxShadow`-uppdateringarna (3 lager med blur) kan orsaka GPU-compositing-tryck som fördröjer BLE-writes på main thread.

**3. Index.tsx 500ms stats-poll — onödiga React-rerenders**
Rad 112-149: `setInterval` var 500ms som sätter ~6 React states (`setBleWriteStats`, `setPipelinePeakMs`, `setTickToWriteMs`). Varje state-ändring triggar en React-render av hela Index-komponenten, inklusive alla barn. Detta kan skapa main-thread-jank som fördröjer BLE-writes.

**4. Död kod — silence detection kvar**
`quietFramesRef`, `SILENCE_THRESHOLD`, `SILENCE_FRAMES` deklareras fortfarande (rad 176-178), används på rad 405 och 705. Bör tas bort helt.

### Plan

| Fil | Ändring |
|-----|---------|
| `NowPlayingBar.tsx` | Ersätt rAF-loop med CSS `transition` på width (browser driver animation, ingen JS-timer) |
| `MicPanel.tsx` | Stoppa rAF-loopen helt vid paus (`!isPlayingRef.current → return early`). Ta bort död silence-kod. |
| `Index.tsx` | Sänk stats-poll från 500ms → 2000ms. Färre React-rerenders = mer main-thread-tid för BLE. |

### Teknisk detalj

Den troligaste orsaken till begränsade writes/sek är att sun-elementets `boxShadow` med 3 blur-lager uppdateras 60 ggr/sek via rAF. Varje frame tvingar GPU-compositing och kan blocka main thread. Vid paus finns ingen anledning att köra detta alls, och vid play kan man begränsa sun-updates till bara när brightPct faktiskt ändras.

