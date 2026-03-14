

## Frekvensbaserad ljusstyrka + bättre drop-filtrering

### Idé
Idag styrs ljusstyrkan (pct) enbart av total RMS. Genom att splitta signalen i frekvenszoner kan vi:
1. **Mid/hi-frekvenser (150+ Hz)** → driver den "normala" ljusstyrkan i ett dynamiskt spann (10-50%)
2. **Bass (<150 Hz)** → boostar ljusstyrkan uppåt (50-100%) när den slår in
3. **Drop-detection** → kräver nu att **bass-bandet** surgar, inte bara total RMS — filtrerar bort falska triggers från t.ex. cymbal-transienter eller röster

### Teknisk plan

**`computeBands()` — ny bandsplit:**
- Sänk `loCut` från 300 Hz till **150 Hz** för att isolera riktig sub-bass/kick
- Returnera även råa (icke-normaliserade) värden för drop-detection

**Brightness-pipeline — frekvensstyrd:**
```
midHiRms = RMS av frekvenser > 150 Hz
bassRms  = RMS av frekvenser < 150 Hz

// Mid/hi driver baslinje 10-50%
midHiNorm = AGC-normalisera(midHiRms) → 0-1
baseBright = minBright + midHiNorm * (50 - minBright)

// Bass boostar ovanpå till max
bassNorm = AGC-normalisera(bassRms) → 0-1
finalBright = baseBright + bassNorm * (effectiveMax - baseBright)
```

**Drop-detection — bassfiltrerad:**
- Byt från total `rms` till `bassRms` i rmsHistoryRef
- En "drop" kräver nu att **basen** surgar — inte sång/cymbaler/hi-hats
- Samma energy-modulerade trösklar som idag

**Debug overlay:**
- Visa `lo Hz` och `mid+hi Hz` nivåer så du kan se hur banden beter sig

### Filer som ändras
- `src/components/MicPanel.tsx` — ny bandsplit-AGC, frekvensstyrd brightness, bassfiltrerad drop
- `src/components/DebugOverlay.tsx` — visa band-nivåer

