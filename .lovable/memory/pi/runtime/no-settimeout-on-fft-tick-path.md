---
name: Inget setTimeout i FFT→tick-pipen
description: onFFTFrame får ALDRIG schemalägga setTimeout för "remaining ms". Det låser tickInner till en gammal getLatestBands() och ger smygande audio→light latens. Bara: kör direkt om elapsed≥tickMs, annars dropp.
type: constraint
---
**Symptom (2026-04-20):** Lampan kändes "ur takt" trots tick=25ms och rate-limit 15ms. Output-staplar visade normala pkt/s.

**Rotorsak:** `piEngine.onFFTFrame` schemalade en `setTimeout(remaining)` när FFT kom för tidigt. När den timeren resolvade ~5-15ms senare anropade den `tickInner()` — men då hade en NY FFT-frame redan kommit och uppdaterat `getLatestBands()`. Det betyder att tickInner ofta körde mot en gammal frame (upp till tickMs gammal i värsta fall) och nästa fräsch frame räknades som dropped.

**Regel:** I onFFTFrame:
- `elapsed >= tickMs` → kör tickInner direkt (FFT-framen är färsk, getLatestBands() har precis uppdaterats)
- annars → räkna `fftDroppedCount++` och returnera. Nästa FFT (~10.7ms senare) triggar nästa check.

**Aldrig:** `setTimeout(remaining, () => tickInner())` — det skapar latens utan att synas i pkt/s.

**Fil:** pi/src/piEngine.ts:onFFTFrame.
