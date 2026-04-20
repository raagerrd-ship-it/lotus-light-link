
## Förbättra BLE-pipeline för tick=25ms

Tre konkreta fixar i `pi/src/ble/protocol.ts` och `pi/src/piEngine.ts` som tar bort onödiga rate-limit-drops och inkonsekvent timing. Ingen UI-ändring behövs.

### Vad vi ändrar

**1. Mindre aggressiv rate-limit-marginal** (`piEngine.ts`)
Idag: `setMinWriteIntervalMs(Math.max(5, ms - 2))` → vid tick=25ms blir gaten 23ms. Timer-jitter på Pi Zero 2W (±3-5ms är vanligt) gör att en tick som kommer 22ms efter förra → blockas av gaten → BLE-write droppas → vi tappar var 3-4:e paket helt i onödan.

Ändring: `setMinWriteIntervalMs(Math.max(5, Math.floor(ms * 0.6)))` → vid tick=25ms blir gaten 15ms (60% av tick). Tillräckligt för att skydda BLEDOM från överbelastning, men låter normal jitter passera.

**2. Konsekvent `lastWriteTime`-semantik** (`protocol.ts`)
Idag: `sendToBLE` sätter `lastWriteTime = now` (write-START), medan keep-alive sätter `lastWriteTime = performance.now()` EFTER `await writeAsync` resolvar (write-END). Det betyder att efter en keep-alive räknar rate-limit-gaten "fel" tidpunkt → första riktiga write efter keep-alive kan blockas felaktigt.

Ändring: Keep-alive sätter `lastWriteTime` precis innan `writeAsync` (samma som `sendToBLE`), inte efter. Båda mäter nu från write-START.

**3. Default tickMs → 25ms** (om ej redan)
Verifiera att engine-default är 25ms. Memory säger redan att 25ms är default men vi dubbelkollar `piEngine.ts` så slidern startar där.

### Förväntad effekt

| Mätning | Före | Efter |
|---|---|---|
| BLE-writes faktiskt skickade @ tick=25ms | ~28-32/s (drops) | ~38-40/s (full takt) |
| `tickAbortBleRateLimitCount` per minut | 200-400 | <20 |
| Attack-latens mic→lampa (medel) | ~30-40ms | ~20-25ms |
| Risk för BLEDOM reason=8 | oförändrad (60% av tick = säker marginal) | oförändrad |

### Filer som ändras

- `pi/src/piEngine.ts` — ändra rate-limit-formeln när tickMs uppdateras
- `pi/src/ble/protocol.ts` — flytta `lastWriteTime`-uppdatering i keep-alive till FÖRE writeAsync
- `mem://pi/ble/write-rate-limit.md` — uppdatera med 60%-regeln

### Vad vi INTE rör

- `MIN_WRITE_INTERVAL_MS`-clamp (5–100ms) — bara hur engine BERÄKNAR värdet ändras
- Keep-alive-intervall (400ms) — orört
- Watchdog (500ms) — orört
- HOP_SIZE (512) — orört
- Delta-skip-logik — orört
