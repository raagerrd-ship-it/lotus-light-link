---
name: Dirigenten — multiplikativ modell + DROPPED_CAL_KEYS-fällan
description: energyForm = ceil × ((1-bd)+bd·pn); pulsen normaliseras mot 0.45, buildUp/ettan höjer taket, trust mot beat-confidence; återanvänd aldrig namn ur DROPPED_CAL_KEYS
type: feature
---

**Takten är grunden, energin sätter taket** (`piEngine.tickInner`, FIX 12):
- `p = onsetBoost / 0.45` (nominella grid-målet). Klampning i stället för
  normalisering gjorde både vanligt slag och ettan ~1.0 → accenten osynlig.
- `pn = min(p,1)` = djup INOM taket; `one = (p-1)/(barAccent-1)` = ettan.
- `ceil = shapeSm·(1 + buildUp·buildUpGain)`, sedan `ceil += (1-ceil)·one·barAccentLift`.
  buildUp/ettan får ALDRIG adderas ovanpå — då klampas pulsen bort just i takterna
  där beatet betyder mest.
- `trust = min(1, beatConfidence/0.4)`, `bd = beatDepth·trust`. Utan trust låg
  taktlös musik/TV/raw-läge permanent på 30 % av energin.
- `transientGain` skalar INTE längre ljuspulsen (bara raw-/onset-vägen).
- `punchWhiteThreshold` är kalibrerad mot den gamla additiva skalan → fyrar mer
  sällan nu; ska omtrimmas.

**Fälla:** `DROPPED_CAL_KEYS` raderar sina namn vid varje `loadCalibration()`.
Återanvänd aldrig ett namn ur listan för en ny funktion (`lightBassWeight` var
död i tysthet från FIX 3 till FIX 12).
