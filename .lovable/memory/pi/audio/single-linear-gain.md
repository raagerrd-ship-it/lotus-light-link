---
name: En ärlig linjär gain (tvåpunkts Sonos-kurva)
description: RAW_SCALE=5 borttagen i piEngine; tvåpunkts-kurvan mot Sonos-volym är ENDA gain-källan (inget manuellt läge, ingen auto-reaktivering). Gain-tal ~5× högre (5–300×).
type: feature
---
**Varför:** dolda ×5 efter FFT mättade signalen redan vid RMS 0.2 → ingen äkta tystnad kvar → drop-detektorn (build→breakdown→drop) och beat-låset fick ingen full-range input.

**Motor:**
- `piEngine.normalizeFixed(v)` = ren clamp 0..1 (ingen skalning).
- `tickEnergyFloor`/`onsetEnergyFloor` jämförs mot RÅ band-RMS → orörda av ändringen.
- `alsaMic`: `micGain = micGainAuto` alltid; `micGainAuto` interpoleras (log) mellan calPoint1/calPoint2 på Sonos-volym. `micGainBase` = fallback + mål för engångs-verktyget (15s auto-mät). AUTO_GAIN_MAX 300.
- Borttaget: `autoGainEnabled`, `autoGainUserDisabled`, `enableAutoGain`, `disableAutoGain`, `maybeAutoEnableAutoGain`. `PUT /api/auto-gain` är no-op (bakåtkompat), `isAutoGainEnabled()` returnerar alltid true.

**UI (PiMobile):** ingen Manuell/Auto-toggle. Två cal-slidrar 5–300× med debounce:ad PUT (150 ms) + snabbpoll 400 ms i 5 s, nivåbar med klipp-zon 90–100 % och peak-hold 0.8 s. Wizarden är ett ENGÅNGS-verktyg som aldrig kör av sig själv.

Efter uppgraderingen måste kurvan sättas om (gamla punkter är ~5× för låga).

**Uppdatering 2026-08-23 — soft-clip borta (helt linjär kedja):**
- `alsaMic` mic-soft-clip `x/(1+|x|)` BORTTAGEN. Lotus spelar aldrig upp ljud, så knät skyddade inget — det komprimerade topparna så gain 8/31/57 alla gav ~50 % ljus.
- `analyser.setGainLock(true, 1)`: analysatorns interna AGC låst på 1×, annars normaliserar den bort mic-gainen.
- `BAND_SCALE = 1.0` (var 0.45) — enda taket är `energyNorm > 1 → 1`.
- `getMicHealth()` mäter nu peak/clip på LJUS-DRIVANDE bandenergin (max av bassRms/midHiRms) i emitBands, inte på PCM-samples. Kalibrering och NIVÅ-bar speglar därmed exakt det ljuset gör.
- Aldrig återinföra soft-clip, AGC eller extra skalkonstanter i mic-pathen.
