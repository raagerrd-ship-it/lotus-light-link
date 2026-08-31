# Granskning: vår analysator vs öppna beat-trackers

## Var vi står

Vår analysator (`pi/src/audio-analyser/analyser.ts`, 48 kHz / hop 128 → 375 Hz, 512-pkt FFT för onset + 2048-pkt var 3:e hop för band) gör redan det som de klassiska DSP-trackerna gör, och på några punkter mer:

- Halvvågs-rektifierad spectral flux, separat kick-band, robust median/MAD-tröskel med subhop-parabolisk timestamping (±1.3 ms).
- Tempogram = autokorrelation + comb-filter (Klapuri) + pulstågs-korskorrelation (Percival–Tzanetakis), log-gaussisk prior kring 120 BPM, oktavfoldning 80–160 BPM.
- Två parallella onset-envelopper (bas + fullband) som röstar — samma idé som Essentias `multifeature`.
- Oktavröstning, grannrättning, låtbytesvakt, rå-AC subharmonisk veto, confidence-baserad låsrelease.
- PLL i `piEngine.ts`: fasnudge 3–40 % skalad av confidence + bunden ±4 BPM frekvenskorrigering, plus coast genom breakdowns.

Jämfört med BTrack (GPLv3), aubio (GPLv3), Essentia (AGPLv3) och librosa `plp` (offline) ligger vi i samma klass. ML-trackerna (madmom DBN, BeatNet, Beat This!) är mätbart bättre men kräver en tensor-runtime — inte realistiskt på Pi Zero 2W utan ML-ramverk, och madmoms DBN är dessutom patent-/licensbelastad. Allt nedan är därför clean-room-implementation från publikationer, ingen kodkopiering.

## Vad som faktiskt är värt att hämta

Prioriterat efter (nytta / CPU-kostnad):

1. **Adaptive whitening per FFT-bin** (Stowell & Plumbley 2007). `peak[k] = max(mag[k], peak[k]*decay)`, sedan `mag[k]/max(peak[k], floor)`. En multiply-add per bin. Gör onset-detektionen oberoende av källvolym och EQ — direkt relevant eftersom vi idag kompenserar med lärd gain + median/MAD. Bör minska både falska kicks vid hög volym och missade kicks vid låg.
2. **Log-magnitudkompression före differensen** (`log1p(C*|X|)`, aubio `specflux` / SuperFlux). En `log1p` per bin. Gör att tysta transienter (hi-hat, snare i verser) inte dränks av basen — bör ge stabilare tempogram i låtar med svag kick.
3. **Comb-filter-resonatorbank i stället för (eller parallellt med) AC** (Scheirer 1998, Böck 2015). En IIR per kandidattempo: `y[n] = (1-α)x[n] + α*y[n-τ]`, O(1) per tempo per envelope-sample vid 100 Hz. Resonatorer har visats slå ren autokorrelation just på oktavfel — exakt det problem vi lappar med veto + röstning idag. Kan köras som en andra röst mot befintligt tempogram innan vi ersätter något.
4. **Nedslagsdetektering via bandbegränsad spektraldifferens** (Davies & Plumbley 2006). Vi har idag bara en 4-slots kick-energi-ackumulator. Rätt metod: mät hur mycket det låga bandets spektralinnehåll ändras takt-över-takt och välj den takt-fas där förändringen är mest konsekvent. Använder flux vi redan beräknar, nästan gratis, och ger säkrare `barShift` i låtar där kicken går på alla fyra.
5. **Novelty-normalisering före peak-picking** (lokal median-högpass + lokal std/max-division). Vi gör redan median/MAD på kickspåret men inte på envelopen som går in i tempogrammet.

## Vad vi medvetet inte gör

- Ingen ML-tracker (BeatNet / Beat This! / madmom-RNN): kräver GEMM-runtime, ~10–80 MB modell, ryms inte i budget och patentläget kring DBN är oklart.
- Ingen Ellis-DP-beat-tracker: offline av konstruktion (backtrace från slutet). Dess transitionsstraff är däremot redan approximerat av vår PLL-gate.
- Ingen `librosa.plp` som den är: kräver Fourier-tempogram över hela klippet.
- Ingen kroma/tonart-analys — vi har ingen ljusfunktion som behöver den.
- Ingen kodkopiering från BTrack/aubio/Essentia (GPL/AGPL).

## Teknisk plan om vi går vidare

Etapp A (låg risk, mätbart): punkt 1 + 2 + 5 i `analyser.ts` onset-steget, bakom en `cal`-flagga så vi kan A/B-mäta med Frame Recorder. Mät antal falska/missade kicks och `bpmConfidence` över samma 25-minuterspass vi använt tidigare.

Etapp B: resonatorbank (punkt 3) som parallell tempo-röst, jämförd mot befintligt tempogram i samma mätning. Ersätter bara om den vinner på oktavfel.

Etapp C: spektraldifferens-nedslag (punkt 4) som ersättning för `barAcc`-heuristiken.

Analysatorn är en spegling av DMX Control-mastern, så varje etapp som godkänns ska in i `pi-dmx/engine/src/analyser.ts` först och synkas tillbaka — annars skrivs den över.
