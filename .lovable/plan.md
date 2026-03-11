

# Refaktorera loop() och fixa dubbel BLE-kick

## Problem 1: Dubbelsändning vid kick
Predictive-pathen (rad 352-378) skickar brightness + vit färg **innan** beaten. Sedan skickar den vanliga throttle-pathen (rad 651-654) brightness igen, och kick-triggern (rad 659-669) skickar vit färg igen — allt för samma beat.

**Fix:** Om `predictiveFiredRef` är `true` och vi är i tidigt beat-fas (`beatPhaseRef < 0.1`), hoppa över den vanliga brightness-sändningen och färg-kicken — predictive har redan gjort jobbet. Reset sker redan vid nästa onset (rad 383).

## Problem 2: loop() är ~430 rader
Bryter ut fyra namngivna funktioner **inuti useEffect** (delar lokala variabler via closure):

```text
loop()
 ├── sampleEnergy()        → läser analysers, AGC, returnerar { energy, transient, isSilence }
 ├── detectBeatsAndBpm()   → onset-detection, BPM-estimering, Sonos phase-sync
 ├── computeBrightness()   → phase-pulse, floor, pct
 ├── updateVisuals()       → DOM-uppdateringar (glow, ring, canvas)
 └── dispatchBle()         → brightness + color med predictive/kick-logik (unified)
```

`loop()` själv blir ~20 rader som anropar dessa i sekvens.

## Ändringar

**En fil:** `src/components/MicPanel.tsx`

### dispatchBle() — unified kick-logik
```typescript
const dispatchBle = (pct: number, curved: number, now: number, isOnset: boolean) => {
  // Predictive pre-fire
  if (bpmRef.current > 0 && bpmConfidenceRef.current > 0.3 && !predictiveFiredRef.current) {
    const beatMs = 60000 / bpmRef.current;
    const msUntilBeat = beatMs - beatPhaseRef.current * beatMs;
    if (msUntilBeat <= BLE_LATENCY_MS && msUntilBeat > 0) {
      predictiveFiredRef.current = true;
      const predictedPct = Math.max(60, Math.round((pulseMaxRef.current ?? 0.7) * 100));
      ble.brightness(predictedPct);
      if (punchWhiteRef.current && predictedPct > 85) {
        // ... white boost (same as before)
      }
      return; // ← skip normal dispatch this frame
    }
  }

  // Normal brightness (throttled) — skip if predictive already sent this beat
  const predictiveActive = predictiveFiredRef.current && beatPhaseRef.current < 0.15;
  if (!predictiveActive && now - throttleRef.current >= 25) {
    throttleRef.current = now;
    ble.brightness(pct);
  }

  // Color kick — skip if predictive already sent white
  if (!predictiveActive && punchWhiteRef.current && curved > 0.98 && beatPhaseRef.current < 0.1) {
    // ... same kick logic
  } else if (colorBoostedRef.current && ...) {
    // ... same fade-back logic
  }
};
```

Nyckeländring: `predictiveActive`-flaggan förhindrar dubbelsändning utan att ändra beteendet i övrigt.

### Övriga funktioner
- `sampleEnergy()` — rad 260-300, returnerar `{ energy, transient, isSilence, rawEnergy }`
- `detectBeatsAndBpm()` — rad 300-479, hanterar onset, BPM, Sonos sync
- `computeBrightness()` — rad 481-507, pulse + floor
- `updateVisuals()` — rad 509-648, DOM + canvas

Inga beteendeändringar förutom eliminerad dubbelsändning.

