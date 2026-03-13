

# Dynamisk ljusstyrning med 4-zons brightness-mapping

## Nuvarande beteende
Brightness-mappingen är en enkel `pct = 3 + 97 * floored^0.8` — en jämn kurva utan zoner. Allt behandlas lika oavsett intensitetsnivå.

## Ny modell: 4 dynamiska zoner

```text
Zone       │ pct-range │ Beteende
───────────┼───────────┼──────────────────────────────────
Ambient    │  0–30%    │ Alltid aktiv, låg tröskel, bredare frekvensband
Groove     │ 30–60%    │ Kräver tydlig takt (onset), måttlig tröskel  
Impact     │ 60–90%    │ Kräver markant takt, hög tröskel
Punch      │ 90–100%   │ Bara vid riktiga punchar (stark transient)
```

### Ändringar

**`src/components/MicPanel.tsx`**:

1. **Bredare frekvensband för ambient-zonen**: Öka mid-bandets bidrag i `sampleEnergy()` — höj mid-vikten från 15% till 30% för en `ambientEnergy` som driver 0-30%-zonen. Den befintliga `rawEnergy` (bas-tung) driver 30%+.

2. **Ny `computeBrightness`-funktion med zonbaserad mapping**:
   - **0–30%**: Drivs av `ambientEnergy` (bred frekvens). Kräver ingen onset. Alltid levande — mjuk logaritmisk mapping av total energi.
   - **30–60%**: Adderas ovanpå ambient. Kräver att `isOnset` nyligen skett (beat-fas < 0.5). Proportionell mot `curved` (beat-decay).
   - **60–90%**: Ytterligare addition. Kräver starkare transient (> 1.5x adaptive threshold). Skalad med transient-styrka.
   - **90–100%**: Bara vid kraftiga transienter (> 2.5x threshold). Kort peak.

3. **Formeln** (ersätter rad 614):
   ```
   ambientPct = 30 * log1p(ambientEnergy * 12) / log(13)  // 0-30, alltid aktiv
   groovePct  = isRecent ? 30 * curved : 0                 // 0-30, kräver takt
   impactPct  = strongHit ? 30 * impactFactor : 0          // 0-30, markant takt
   punchPct   = superHit ? 10 * punchFactor : 0            // 0-10, riktig punch
   pct = clamp(ambientPct + groovePct + impactPct + punchPct, 3, 100)
   ```

4. **`sampleEnergy` returnerar även `ambientEnergy`** — en bredare mix med mer mid/high-frekvens.

### Filer att ändra
- **`src/components/MicPanel.tsx`**: `sampleEnergy()` och `computeBrightness()`

