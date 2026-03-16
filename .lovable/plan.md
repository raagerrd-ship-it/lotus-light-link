

## Ändra tick-slider till 20–100 ms

### Problem
Nuvarande slider arbetar i WPS (25–75) med `Math.round(1000/wps)` konvertering, vilket ger avrundningsfel och stegknapparna "fastnar".

### Lösning — arbeta direkt i ms, range 20–100

**Fil: `src/components/CalibrationOverlay.tsx` rad 394–442**

1. **+ knappen** (snabbare = lägre ms): `onTickMsChange?.(Math.max(20, tickMs - 1))`
2. **− knappen** (långsammare = högre ms): `onTickMsChange?.(Math.min(100, tickMs + 1))`
3. **Slider drag** — mappa rawPct direkt till ms:
   - `const ms = Math.round(100 - rawPct * 80)` (topp=20ms, botten=100ms)
4. **Thumb position**: `pct = ((100 - tickMs) / 80) * 100`
5. **Default-linje**: samma formel med `DEFAULT_TICK_MS`
6. **Label**: behåll `w/s` display som `Math.round(1000 / tickMs)`

**Fil: `src/pages/Index.tsx`** — clamp initial `tickMs` till giltigt intervall om `DEFAULT_TICK_MS` hamnar utanför 20–100.

