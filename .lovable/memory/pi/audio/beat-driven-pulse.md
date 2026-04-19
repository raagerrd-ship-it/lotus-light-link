---
name: Beat-driven puls via spectral flux
description: pi/src/piEngine.ts processOnset triggar stark kort puls (0.45) med 110ms refractory för att lampan ska blinka i takt med trumslag
type: feature
---
För att lampan ska reagera "i takt med låten" används spectral flux (beräknas i alsaMic.ts) som onset-detektor.

**Inställningar (pi/src/piEngine.ts)**:
- `onsetTarget = 0.45` (tidigare 0.22) — stark, tydligt synlig puls
- Tröskel: `med * 1.8 + 0.008` (tidigare 1.5 + 0.005) — striktare så bara riktiga slag triggar
- `ONSET_REFRACTORY_MS = 110` — minsta gap mellan onsets, undviker flutter på sustained ljud
- `onsetDecay = pow(0.04, secRatio)` (tidigare 0.10) — kortare puls, matchar trum-attack ~80ms
- `onsetRiseAlpha = pow(0.05, ratio)` (tidigare 0.15) — snabbare attack på pulsen

Pulsen adderas ovanpå `energyNorm` i tickInner steg 6 (transient boost), styrs av `cal.transientBoost`.

Build tag: `2026-04-19/beat-driven-pulse`
