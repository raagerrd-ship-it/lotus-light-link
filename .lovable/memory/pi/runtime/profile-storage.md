---
name: profile-storage
description: 4 oberoende kalibreringsprofiler (Lugn/Normal/Party/Custom) lagras i pi/data/profiles.json. Aktiv profil pluggas in i light-calibration via engine.setActiveProfile().
type: feature
---
4 oberoende profiler — Lugn, Normal, Party, Custom — lagras tillsammans med activePreset i `pi/data/profiles.json` via storage.ts. Varje profil bär sina egna värden (bassWeight, releaseAlpha/softness, dynamicDamping, brightnessFloor, punchWhiteThreshold, perceptualGamma, transientGain, dynamicsEnabled, hiShelfGainDb).

**API:**
- `GET /api/profiles` → `{ profiles, activePreset }`
- `PUT /api/profiles` `{ profiles, activePreset }` — ersätter/merger alla 4
- `PUT /api/active-preset` `{ name }` — byter aktiv profil

**Aktiv profil härleder pipelinen:** `engine.setActiveProfile(cal)` skriver profilen till `light-calibration` och kör `reloadCalibration()`. Befintlig pipeline (gain → bands → dynamics → gamma → punch) ändras inte.

**Bakåtkomp:** `PUT /api/calibration` speglar nu skrivningen i aktiv profil i `profiles.json` så källan-till-sanning förblir profiles.

**Seed:** Vid första boot (om `profiles.json` saknas) seedas DEFAULT_PROFILES. Om legacy `light-calibration.json` finns pluggas den in i Normal så ingen kalibrering förloras.

**UI:** Klick på profil-knapp byter `activePreset` lokalt + `PUT /api/active-preset`. Slidrar muterar `profiles[activePreset]`. Save skickar hela `profiles`-objektet via `PUT /api/profiles`.
