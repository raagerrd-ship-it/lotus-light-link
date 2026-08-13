---
name: Taktklocka (beatClock) + PLL + grid-driven puls
description: pi/src/audio-analyser/beatClock.ts + updateBeatClock i piEngine — tempo från analysatorn, fas knuffad av kicks, pulsen fyras av rutnätet med beatLeadMs försprång
type: feature
---

Portad från DMX Control (`pi-dmx/engine/src/beatClock.ts` = master, denna är mirror).

**beatClock.ts** — ren matematik: `hasBeat` (konfidensgrind 0.20), `beatMs`,
`beatPhase(beat, now, leadMs)`, `beatIndex`, `nextBeatIn`. Konsumenten äger sitt
försprång, klockan äger matematiken.

**piEngine.updateBeatClock(kick)** körs i `onFluxReady` (100 Hz):
- Tempo från `getLatestFrame().bpm`; om-ankrar bara vid >2 BPM avvikelse, och
  bevarar då fasen (annars strobar pulsen vid varje BPM-hopp).
- PLL: `anchorMs += err * beatMs * k`, `k = beatSyncStrength * (0.3 + 1.4*conf)`
  clampad 0.03–0.4. Fasfel |err| ≥ 0.25 ignoreras (off-beat/synkoper).
- PI-frekvensterm justerar BPM ±4 kring det detekterade när conf > 0.4.

**Grid-driven puls**: när `hasBeat` är sant sätts `onsetTarget = 0.45` av ett nytt
`beatIndex(now + beatLeadMs)` i stället för av onseten. `processOnset` körs ändå
(PLL:en behöver flankerna) men får `allowTrigger = false`. Utan lås → oförändrat
reaktivt beteende.

**Nya cal-fält**: `beatGridPulse` (true), `beatLeadMs` (60 ms, kompenserar BLE-
skrivlatens 40–60 ms), `beatSyncStrength` (0.18, 0 = PLL av).

**Telemetri**: `/api/status` → `beat: { locked, bpm, confidence, phase,
nextBeatMs, beatErr, gridPulses, leadMs }`.
