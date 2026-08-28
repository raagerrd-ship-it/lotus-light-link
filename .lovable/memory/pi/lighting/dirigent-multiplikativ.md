---
name: Dirigenten — multiplikativ modell, trust=locked, DROPPED_CAL_KEYS-fällan
description: energyForm = ceil × ((1-bd)+bd·pn); trust = locked (ALDRIG confidence, AUC 0.355); auto-dubbel <105 BPM; DROPPED_CAL_KEYS-namn får aldrig återanvändas
type: feature
---

**Takten är grunden, energin sätter taket** (`piEngine.tickInner`):
- `p = onsetBoost / 0.45` (nominella grid-målet); klampning gjorde både vanligt slag
  och ettan ~1.0 → accenten osynlig.
- `pn = min(p,1)` = djup INOM taket; `one = (p-1)/(barAccent-1)` = ettan.
- `ceil = shapeSm·(1 + buildUp·buildUpGain)`, sedan `ceil += (1-ceil)·one·barAccentLift`.
  buildUp/ettan får ALDRIG adderas ovanpå pulsen.
- `trust = hasBeat(beat) ? 1 : 0`. **Använd ALDRIG `confidence`** — anti-diagnostisk
  (AUC 0.355; 34 % av fel-tempo-sampel har conf 1.000).
- `transientGain` skalar INTE ljuspulsen (bara raw-/onset-vägen).

**Intrimmat (4 943 sampel / 7 låtar):** beatDepth 0.45 (0.70 = strobe), barAccentLift 0.30,
brightnessFloor 28, anchorDb −1.5, windowDb 19, lightSmoothMs 60, flickerDeadband 0.020
(höj inte), lightBassWeight 0.9, lightHiWeight 0.3, beatLeadMs 45 (rör inte).
Resultat: fladder 21.6 → 7.5; takt/sektion-kvot 2.70 → 1.05.

**AUTO-DUBBEL i dirigenten** (inte i analysatorn): `beatDoubleBelowBpm` 105 pulsar
halvslag när låtens takt är låg (194-BPM-låt viks till 97). Halvslaget får ingen
ettans-accent. `beatMultiplier` = manuell override. Fält: `_lastGridIdxH`.

**Kända strukturella brister (kräver kod, ej trim):** `onset` bär ingen ljudinfo när
gridet driver (ren metronom, τ≈0.32 s) → drops måste komma från `buildUp`/`dropCount`/
`wdb`-derivata. `barShift` beräknas aldrig → barAccent/barAccentLift inerta.
`intensity` är rullande AGC → använd `wdb` för sektionskontrast. Unlock = hård blackout
(coasta på senaste goda tempo vore bättre). `punchWhiteThreshold` är kalibrerad mot
gamla additiva skalan → fyrar sällan, ska omtrimmas.

**Fälla:** `DROPPED_CAL_KEYS` raderar sina namn vid varje `loadCalibration()`.
Återanvänd aldrig ett namn ur listan (`lightBassWeight` var död i tysthet FIX 3→FIX 12).
