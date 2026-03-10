

## BPM-detection med beat-synkad färg-fade

### Idé
Detektera BPM i realtid från mikrofonens basfrekvenser och använda det för att styra hur snabbt punch-färgen fadeas tillbaka. Vid 120 BPM = 500ms per beat, så fade-tiden anpassas så att färgen hinner ner precis lagom till nästa slag.

### Approach: Onset-interval BPM-detektor
Ingen tung FFT-baserad korrelation behövs. Enkel och snabb metod:

1. **Beat onset detection** — I den befintliga rAF-loopen, detektera när `curved` korsar en tröskel uppåt (t.ex. 0.5). Spara tidsstämpeln.
2. **Interval tracking** — Håll en cirkulär buffer med de senaste ~8 onset-intervallen. Beräkna median-intervall = beat period.
3. **BPM = 60000 / medianInterval** — Filtera rimligt range (60–200 BPM).
4. **Dynamisk decay** — Istället för fast `0.85` envelope release, beräkna release-koefficient så att envelopen når ~0.1 på exakt en beat-period:
   ```
   releaseCoeff = Math.pow(0.1, 1 / (beatPeriodFrames))
   ```
   Där `beatPeriodFrames ≈ (60/BPM) * 60` (vid 60fps).
5. **Punch-färg fade** — Samma princip: fade-tillbaka-tiden för color boost anpassas till beat-perioden istället för fasta 70/100ms throttles.

### Ändringar i MicPanel.tsx

- Nya refs: `onsetTimesRef` (cirkulär buffer), `bpmRef`, `lastOnsetRef`, `bpmDisplayRef` (DOM ref)
- I loopen: onset-detection efter `curved` beräknas, BPM-uppdatering var ~2s
- Envelope decay: `prev * releaseCoeff` istället för `prev * 0.85`
- Color throttle: dynamisk baserad på beat-period
- UI: Visa detekterat BPM som text under ljusstyrka-baren (direct DOM update)

### Prestanda
Inga nya audio-noder, ingen extra FFT. Bara ~10 extra operationer per frame (jämförelse + array push + median var 120:e frame). Ingen latens-påverkan.

