---
name: Två synliga kontroller — input-gain vs ljus-skala
description: INPUT-GAIN (rå PCM, tvåpunkts mot Sonos) matar analysatorn full dynamik; LJUS-SKALA (cal.lightScale, default 0.8) mappar energi → lampa med headroom så drops (100%) syns. NIVÅ-baren visar BLE brightness.
type: feature
---
**2026-08-23.** En gain kan inte göra båda: hög gain (bra analys) maxar lampan → drops osynliga vid 98–100 %; låg gain svälter analysatorn.

- **Modul 1 – INPUT-GAIN:** tvåpunkts Sonos-kurva på rå PCM, ingen soft-clip, ingen AGC. Sätts högt/brett för beat/drop/frekvens-upplösning.
- **Modul 3 – LJUS-SKALA:** `LightCalibration.lightScale` (per profil, default 0.8, slider 0.30–1.00). Appliceras i `piEngine.tickInner` steg 7: `_e = energyNorm * tc.lightScale` innan floor/perceptualGamma/klamp. Fast, aldrig adaptiv. Drop-blixten skriver 100 % direkt → headroom-et är dess synlighet.
- **UI:** NIVÅ-baren visar `ble.lastSent.brightness` (post-gamma, "Lampa (BLE)") med peak-hold + 100 %-tak — UI = lampa. Separat kompakt "Analysator-input"-indikator för gain-hälsan.
- **Save-bug fixad:** `PUT /api/gain-calibration` behåller befintliga punkter när body saknar giltig punkt (tidigare `point1 ?? null` → gain=1). Samma guard i `applyProfileGlobals`.
