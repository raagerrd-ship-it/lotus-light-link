---
name: Tempo-lås — vikning 90..180, snabb commit, ren omlåsning, tystnads-släppning
description: BPM-vikning exakt en oktav (90..180); commit 24 / låtbytesvakt 60; hintTrackChange nollar localBpm; tystnad behåller gissningen via keepBpm
type: feature
---

`pi/src/audio-analyser/analyser.ts`:

- **Vikning 90..180** = exakt 2× MIN → entydigt. Följd: `b` och `2b` kollapsar till samma
  representant, så ett äkta oktavfel kan ALDRIG visa sig som `ratio ≈ 2`; `ratio > 1.4` /
  `< 0.7` fångar 3:2-/triol-artefakter, inte oktaver. Off-beat-testet (`bestLag = P`) är
  en no-op mot oktaven. Vidga INTE till 70–200 (2.86× → tvetydigt, tempot kan växla mitt
  i låten). Snabba låtar presenteras dubbelt av dirigentens auto-dubbel.
- **Asymmetrisk commit:** `committed = bpmStable >= 24` (~6 s, oktav-lås) men
  `committedNow = bpmStable >= 60` (~15 s, låtbytesvakten ska vara konservativ).
- **Grannrättning gatad** `!committed && ratio 0.7..1.4` — annars läcker `ratio < 0.7` in
  och halverar bakvägen.
- **`hintTrackChange(windowMs, keepBpm=false)`** = REN omlåsning: `localBpm = 0`,
  confidence 0, tempoGram rensad. Bevarad startgissning gav 3.5–23.4 s hill-climb per låt.
  `localBpm = 0` ger stride 1 i stället för 25.
- **Tystnad** kallar `hintTrackChange(5000, true)` (flank-triggat vid 350 ms): släpp låset,
  behåll gissningen; full släppning efter 10 s.
- **Släppning som inte bygger på tystnad:** conf < 0.3 i > 8 s → `hintTrackChange(5000, true)`.
  Skäl: Sonos-hinten missas i TV/SPDIF-läge, på radio/streams och vid pollnings-backoff.

**Förkastat efter mätning:** `ratio > 1.4` alltid tillåten (trumfill lyfte 90→135
permanent), halvering permanent av, `bpmStable *= 0.5` vid byte (committar nytt lås utan
bevis), off-beat-test gatat bakom commit (no-op).
