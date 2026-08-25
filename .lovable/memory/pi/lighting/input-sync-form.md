---
name: Input-sync — formen ÄR den råa inputen
description: Ljus-formen drivs av bands.totalRms (lightRawRms × tvåpunkts-gain, ingen AGC). frame.intensity används BARA till topp-boost >90%. Ingen loudness-multiplikation på outN. beatLeadMs = 0.
type: feature
---
Ersätter Dirigent v2 (intensity som form) och loudness-mappningen (2026-08-25, v1.0.762).

**Varför:** Spotify/Sonos loudness-normaliserar låtar → det finns inga tysta vs höga
LÅTAR, bara tysta vs energi-PARTIER inom en låt. `frame.intensity` är sektions-relativ
(0.5 = låtens eget snitt) → tysta partier landade ~0.3 och blev för ljusa.
**Föreslå ALDRIG intensity som form-källa igen.**

**Kedjan i `piEngine.tickInner`:**
- `shape = clamp(bands.totalRms)` (ljus-tappen, ingen AGC).
- Topp-boost FÖRE smoothingen: om `bands.shape` (intensity) > 0.9 →
  `shape += (px-0.9)*10*cal.peakBoost` (default 0.2, tröskel hårdkodad 0.9).
  Måste ligga före smoothingen så soft-releasen fadear ner den jämnt (inget hack).
- Heartbeat: `attackAlpha 1` + mjuk `releaseAlpha` → `shapeSm`.
- `energyForm = shapeSm + fluxBoost` (klamp 1), `outN = floorN + energyForm*(1-floorN)`.
  **Ingen loudness/ampEnv-faktor** — formen ÄR amplituden, att gånga dubbelräknar.

**beatLeadMs = 0:** input-pulsen är reaktiv (kan ej tidigareläggas). Leds punchen före
hamnar den i otakt med input-pulsen → två låga bumpar. Med 0 staplas de → en skarp träff.

**Persisterade defaults (v1.0.762):** gain point1 {vol:12, gain:23} / point2 {vol:45,
gain:2.3}, brightnessFloor 25, releaseAlpha 0.45, attackAlpha 1, transientGain 0.4,
beatLeadMs 0, beatSyncStrength 0.10, dropEnabled false, peakBoost 0.2, lowSoftFloor 0.3,
bassWeight 0.95.

Volym ≠ ljusstyrka: tvåpunkts-gainen sjunker när Sonos-volymen höjs → amplituden ~konstant.
Ingen normalisering av ljus-tappen, ingen dynamicCenter, inga profiler.
