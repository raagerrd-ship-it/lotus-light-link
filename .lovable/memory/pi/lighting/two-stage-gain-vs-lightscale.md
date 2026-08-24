---
name: En signal — input-gain, ljus-bredd och ljus-skala
description: Tvåpunkts Sonos-gain är enda input-gainen (ingen AGC på ljusvägen). Ljuset har egen bas-vikt (lightBassWeight) och lightScale appliceras SIST efter gamma. UI-baren visar ble.lastSent.pct.
type: feature
---
**Kedjan (2026-08-24, v1.0.741):**
1. **Input-gain:** tvåpunkts Sonos-kurva på rå PCM. Ingen soft-clip, ingen AGC på ljusvägen. Analysatorns `specAbs` (icke-AGC:ad) används bara som spektral ANDEL; amplituden kommer linjärt ur `levelVU`.
2. **Ljus-bredd:** `lightBassWeight` (default 0.5) styr LJUSET. `bassWeight`/`beatCutoffHz` styr fortsatt BEAT-detektionen — smalt bas-filter för beat får inte göra ljuset dimt på diskant-tungt innehåll.
3. **Skal-stack:** ordning är `perceptualGamma` FÖRST, `lightScale` SIST. Då blir lightScale ett rent tak (100 % in → lightScale × 100 % ut). Inget extra knä — det stackade tidigare med gamma och kapade mitten (100 % in gav 50 % ut).
4. **UI = lampa:** `LampMeter` läser `ble.lastSent.pct` (exakt kommenderad 0–100). Input-baren läser `live.inputLevel` ur SAMMA /api/status-sample (tids-synkad, ingen ×4-inflation).

**Spara-bug (fixad):** `PUT /api/gain-calibration` skriver bara över punkter med giltig `vol`+`gain>0`; partiella PUT:ar nollar inte kurvan till gain=1.
