---
name: Absolute energy gate för onset-detektorn
description: cal.onsetEnergyFloor (default 0.05) gates processOnset() med bands.totalRms så bakgrundsbrus inte triggar pulser i tysta partier
type: feature
---

**Problem:** Adaptiv median-relativ onset-tröskel skalar ner till brusgolvet i tysta partier → bakgrundsbrus triggar express-onset-bursts → lampan flashar i tystnad.

**Fix:** I `pi/src/piEngine.ts` `onFluxReady`-callbacken gates `processOnset(flux)` av en absolut energi-tröskel:

```ts
const bands = getLatestBands();
const energyFloor = this.cal.onsetEnergyFloor ?? 0;
const passesEnergyGate =
  energyFloor <= 0 ||
  (bands && Number.isFinite(bands.totalRms) && bands.totalRms >= energyFloor);
if (passesEnergyGate) this.processOnset(flux);
```

`bands` hämtas EN gång och delas med dynamicCenter-uppdateringen i samma callback (inte två separata `getLatestBands()`-anrop).

**UI-knob:** "Beat energi-golv" i Calibration, range 0–0.20 step 0.005, default 0.05.
**Profile-defaults:** Lugn 0.05, Normal 0.05, Party 0.03 (lite mer trigger-glad), Custom 0.05.

**Förhållande till `onsetThreshold`:** energy gate löser "flash i tystnad" UTAN att man behöver höja onsetThreshold (= missar riktiga kicks). Båda parametrarna behövs — tröskeln för relativ kontrast, golvet för absolut volymnivå.
