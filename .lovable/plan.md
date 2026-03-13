

## Vad mer kan vi spela in?

Just nu sparas en enda sak: `e` (normaliserad energi) varje 100ms. Det räcker för grundläggande ljusstyrka, men vi tappar viktig information.

### 1. White kick-tidsstämplar

Största förbättringen. Idag triggas white kick när `pct > 95%`, men vid uppspelning från kurvan smoothas topparna — kickarna försvinner. Om vi sparar exakta tidsstämplar för varje kick kan de spelas upp med precision.

**Format i `energy_curve`:**
```json
{ "t": 42.3, "e": 0.72, "kick": true }
```

### 2. Frekvensbands-energi (low/mid/high)

Mikrofonen har en FFT redan. Vi kan spara tre bands per sample:
- **Low** (< 300 Hz): bas, kick drum
- **Mid** (300–2000 Hz): sång, gitarr
- **High** (> 2000 Hz): hi-hat, cymbaler

Vid uppspelning kan vi variera färgtemperatur: bas-tunga sektioner → varmare färg, treble → kallare/vitare. Ger mer levande ljus.

**Format:**
```json
{ "t": 42.3, "e": 0.72, "lo": 0.8, "mid": 0.4, "hi": 0.2 }
```

### 3. AGC-tillstånd (max/min vid inspelning)

Spara `agcMax` och `agcMin` vid inspelningens slut så att uppspelningen inte behöver "värma upp" AGC:n.

### Implementering

- Utöka `EnergySample` med `kick?: boolean`, `lo?: number`, `mid?: number`, `hi?: number`
- I mic-tick: beräkna band-energier från FFT-datan (som redan finns via `analyser`)
- I mic-tick: markera `kick: true` när white kick triggas
- Vid uppspelning: trigga white kick från sparade timestamps istället för pct-tröskel
- Vid uppspelning: blanda färgpaletten baserat på lo/mid/hi-fördelningen
- Spara AGC-state som metadata i `song_analysis` (nytt fält `agc_state jsonb`)

### Steg

1. Utöka `EnergySample`-typen med `kick`, `lo`, `mid`, `hi`
2. I MicPanels tick-loop (mic-mode): beräkna frekvensband från FFT, spara kick-flagga
3. I MicPanels tick-loop (curve-mode): läs `kick` för white kick, `lo/mid/hi` för färgmodulering
4. Liten färgskiftlogik: interpolera mot vitare vid högt `hi`, varmare vid högt `lo`

Storlek: ~3 extra floats per sample ≈ +50% data, fortfarande under 100KB per låt.

