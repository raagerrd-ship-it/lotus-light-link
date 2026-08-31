---
name: Analysator-synk mot DMX Control
description: pi/src/audio-analyser är read-only mirror av DMX Control-mastern; senaste synk commit e5a72e88 (tempogram-BPM, kickAtMs, barShift).
type: feature
---
`pi/src/audio-analyser/analyser.ts` + `beatClock.ts` är MIRROR. Master:
DMX Control → `pi-dmx/engine/src/analyser.ts`. Ändra aldrig här utan att först
ändra i DMX-projektet.

**Senaste synk: commit `b48456cf` (2026-08-31).** Denna synk tar in masterändringarna
för robustare tempo-/onsetanalys, procentil-AGC, dB-baserad riser-detektion,
prestandaoptimeringar och säkrare virtuell klocka. Lotus-adaptern behåller
`specAbs` för den linjära ljusvägen samt `AnalyserConfig`/`setBeatGrid()`. Tidigare från mastern:
- BPM via ackumulerat **tempogram** (EMA över lag-kurvan) + comb/pulse-xcorr,
  lokal whitening (1 s glidande medel) och förberäknad prior-LUT.
- Separat **bas-onset-envelope** (`envBassRing`) röstar ihop med helbandet.
- `frame.kickAtMs` — färdigmätt slagtid med sub-hop-precision (±1.3 ms), kommer
  EN hop efter `frame.kick`. Enda tidsstämpeln en PLL bör mäta fasfel mot.
- `frame.barShift` — hur många slag ankaret ska flyttas för att landa på ettan
  (-1 = osäkert). Lotus har ingen takt-effekt än → oanvänd.
- `frame.mid`/`frame.treble` (512-FFT) är BORTA; använd `spec.mid`/`spec.treble`.

**Lotus-adapter (enda tillåtna avvikelsen):** `AnalyserConfig` mappas i
konstruktorn till samma interna `cfg`-form som mastern, och `cfg.beat` sätts
utifrån via `setBeatGrid()`. Dessutom behålls `magBigMax`-optimeringen
(magnitudloopen stannar vid bin 683 om ingen `specSink` är kopplad).

**Motor-koppling:** `piEngine.updateBeatClock` matar analysatorn med PLL-gridet
via `setAnalyserBeatGrid()` och mäter fasfel mot `kickAtMs` när det är färskt
(<60 ms), annars `Date.now()`.
