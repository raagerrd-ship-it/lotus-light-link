---
name: Rå-AC-veto mot subharmoniska låtbyten (asymmetriskt)
description: Comb-filtret är orsaken till 2/3-excursionerna; vetot jämför RÅ acScratch mellan utmanare och lås, strikt nedåt (0.95) och löst uppåt (0.55)
type: feature
---

`pi/src/audio-analyser/analyser.ts`, låtbytesvakten (`newSongVote`-grenen).

**Mekanismen.** `out[lag] = (0.5·comb/combMax + 0.5·pulse/pulseMax)·priorLut[lag]` med
`comb = ac[L] + 0.5·ac[2L] + 0.33·ac[3L]`. En 2/3-kandidat ligger på lag 1.5P: rå
`ac[1.5P]` är LÅG (slagen möts inte), men `ac[3P]` träffar perfekt och adderas med
vikt 0,5. **Comb-filtret är självt orsaken** — subharmoniken har ingen egen
självlikhet, den lånar styrka från sin egen tredje harmonisk.

**Diskriminatorn.** Rå `acScratch` (helbandet; `scoreEnv` körs sist för full band, så
fältet är färskt) vid utmanarens lag mot låsets lag. Två array-uppslagningar, noll ny
kostnad. Vid veto: `newSongVote *= 0.7` (samma vädring som en osund ruta).

**Asymmetrin.** En subharmonisk är alltid långsammare än låset → `need = 0.95`.
Uppåt (äkta snabbare låt, eller lås som fastnat på en subharmonisk) `need = 0.55` så
omlåsning inte bromsas.

**Förkastat:** `scoreBass[lag]` som basstöd-test — den går genom samma `out[]`-formel
och är också comb-boostad, så den ärver exakt samma fel. Den mäter symptomet, inte
orsaken.

**Mirror-notis:** analysatorn är en mirror av DMX Control-mastern. Detta veto är
infört på Lotus-sidan först och måste bakas in i `pi-dmx/engine/src/analyser.ts` vid
nästa synk, annars skrivs det över.
