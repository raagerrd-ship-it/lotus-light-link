

## Plan: BPM-synkad baspuls med ren pulsform

### Problem
Ljuset följer energikurvan kontinuerligt istället för att skapa tydliga pulser synkade till basslag. Onset-detektionen har fast tröskel (0.3) som inte anpassas, och brightness-kurvan är mer "wave" än "pulse".

### Lösning
Omarbeta pulslogiken i `MicPanel.tsx` till en **beat-trigga puls-modell**:

1. **Adaptiv onset-tröskel** — Istället för fast `transient > 0.3`, använd en dynamisk tröskel baserad på löpande medel av transienter. Starkare slag triggar, svagare brus ignoreras.

2. **Pulsformad brightness** — När ett basslag detekteras, starta en puls som:
   - Omedelbart går till 100%
   - Fadar ner med en cosinus/exponentiell kurva synkad till BPM (nästa beat = tillbaka vid golvet)
   - Golvnivå ~5-8% mellan slag

3. **Beat-phase tracking** — Håll koll på var i beat-cykeln vi är (0.0 = slag, 1.0 = nästa slag). Om BPM är känd, interpolera brightness baserat på phase istället för rå energi. Nya onsets resettar phase till 0.

4. **Starkare bassfiltrering** — Sänk lowFilter Q till smalare band runt kickdrum (40-80Hz), öka vikten på peak vs RMS för skarpare transient-detektion.

### Tekniska ändringar i `MicPanel.tsx`

- Ny ref `beatPhaseRef` (0→1 per beat-cykel)
- Ny ref `adaptiveThreshRef` för dynamisk onset-tröskel  
- Pulsform: `brightness = floor + (1 - floor) * Math.pow(1 - phase, 2)` (kvardratisk falloff)
- BPM-driven phase-advance per frame: `phase += 1 / framesPerBeat`
- Onset resettar phase till 0, ger omedelbar spike
- Behåll AGC och BPM-detektion som de är

