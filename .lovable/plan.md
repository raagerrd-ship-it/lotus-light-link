

# 3-bands frekvensfilterjustering

## Ändringar i `src/components/MicPanel.tsx`

### 1. Lägg till tredje analyser-ref (rad 138–139)
Lägg till `subAnalyserRef` bredvid befintliga refs.

### 2. Filterconfig i `start()` (rad 170–196)
Ersätt nuvarande 2 filter med 3:

| Band | Typ | Frekvens | Q | Roll |
|------|------|----------|-----|------|
| **Sub/Kick** | Lowpass | 100 Hz | 0.7 | Kick, sub-bas |
| **Bas** | Bandpass | 150 Hz | 0.8 | Bas-gitarr, synth |
| **Low-mid** | Bandpass | 350 Hz | 1.0 | Snare body, vokaler |

Tre analysers ansluts till respektive filter.

### 3. Energiberäkning i `sampleEnergy()` (rad 217–261)
Läs tre analysers, beräkna:
```text
subEnergy  = subRms * 0.3 + subMax * 0.7           // 100% cap
bassEnergy = (bassRms * 0.3 + bassMax * 0.7) * 0.9  // 90% cap
midEnergy  = (midRms * 0.3 + midMax * 0.7) * 0.5    // 50% cap
rawEnergy  = subEnergy * 0.55 + bassEnergy * 0.30 + midEnergy * 0.15
```

### 4. Cleanup i `stop()` och guard i `useEffect`
Nollställ `subAnalyserRef` i `stop()`, lägg till i guard-check.

