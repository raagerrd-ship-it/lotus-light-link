

## Synka diagram med BLE-ljus

### Problem
I den nuvarande pipelinen sker BLE-sändningen **före** diagrammet uppdateras (rad 270→288). Dessutom sätts `lastSampleTimeRef` efter BLE-skrivningen, vilket gör att scroll-animationen startar sent. Resultatet: ljuset blinkar vitt direkt, men diagrammet visar spiken ~1-2 frames senare och animerar in den gradvis.

### Lösning
Flytta chart-sample-push och `lastSampleTimeRef`-reset till **före** BLE-sändningen i `worker.onmessage`-callbacken. Då kommer:
1. Diagrammet får det nya samplet samtidigt som BLE-kommandot skickas
2. Nästa rAF-frame (inom ~16ms) visar spiken
3. BLE-sändningen sker parallellt utan att fördröja chart-uppdateringen

### Ändring

**`src/components/MicPanel.tsx`** — Byt ordning i tick-callbacken:

Nuvarande ordning (rad 261-293):
```
1. BLE send (sendToBLE)
2. bleEnd = performance.now()
3. Push chart sample
4. lastSampleTimeRef = performance.now()
```

Ny ordning:
```
1. Push chart sample
2. lastSampleTimeRef = performance.now()
3. BLE send (sendToBLE)
4. bleEnd = performance.now()
```

Detta är en minimal ändring — bara flytta rad 280-293 (chart-blocket) till före rad 261-278 (BLE-blocket). Timing-mätningen justeras så `bleCallMs` fortfarande mäts korrekt.

