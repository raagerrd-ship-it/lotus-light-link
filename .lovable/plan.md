

## Plan: Revert R↔B swap i `_flush`

### Analys

Du har helt rätt. Idle-färgen (t.ex. orange `[255, 60, 0]`) går genom **exakt samma väg**: `sendToBLE` → `_pendingColor` → `_flush` → `_colorBuf`. Om idle-orange visar rätt på stripen, var kanalordningen redan korrekt **innan** min swap. Min ändring har alltså **inverterat** R och B för alla färger.

Flödet:
- **Idle**: `applyColorCalibration(idleColor)` → `sendToBLE(r, g, b, bright)` → `_flush`
- **Musik**: `applyColorCalibration(baseColor)` → `modulateColor(...)` → `sendToBLE(r, g, b, pct)` → `_flush`

Båda passerar identisk `_flush`-kod. Om idle fungerar, fungerar protokollet.

### Ändring

**`src/lib/bledom.ts`** — Återställ kanalordningen i `_flush`:
```typescript
// Revert: standard RGB order (idle colors prove this is correct)
_colorBuf[4] = r;
_colorBuf[5] = g;
_colorBuf[6] = b;
```

Ta bort kommentaren om "BLEDOM hardware has R↔B channels swapped" — det stämmer inte baserat på idle-beteendet.

### Nästa steg

Om du fortfarande ser "blå i UI men röd på strip" efter reverten kan felet ligga uppströms — t.ex. i hur paletten extraheras från albumomslaget (`colorExtract.ts`) eller i `modulateColor`. Men det bör undersökas separat.

