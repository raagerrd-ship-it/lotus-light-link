

## Analys & förbättringsförslag för BLE-kalibrering

### Vad du har idag

1. **BLE Speed (intervall)** — Perceptuellt test som hittar kortaste puls lampan kan visa. Bestämmer min-intervall för schedulern.
2. **Latens (tap-sync + metronom)** — Mäter fördröjning mellan BLE-kommando och synligt ljus på lampan.

Dessa två täcker grundfrågan: *hur ofta* och *hur långt efter*.

### Problem med nuvarande implementation

**Tap-sync-testet har en bugg i logiken:**
- Skärm-flashen fördröjs med `offsetMs`, men BLE-kommandot skickas *omedelbart*. Det betyder att offset = 0 → skärm och BLE skickas samtidigt, men lampan syns ~50-100ms *efter* (pga BLE-transport). Användaren svarar "lampan efter" → offset ökar → skärmen fördröjs mer → till slut matchar de. Offseten representerar då den *faktiska* BLE-latensen. **Detta är korrekt logik**, men:
  - Sökintervallet [-20, 200] kan vara för smalt för långsamma lampor
  - En enda blink per runda ger låg precision — mänsklig reaktionstid dominerar

**Metronom-testet:**
- Offset-slider steg på 5ms är bra, men `setInterval` har jitter (±5-15ms) som gör det svårt att uppnå precision under ~15ms

### Förbättringar

**1. Upprepa varje tap-sync-nivå 3 gånger**
En enda blink per offset-nivå ger osäkert svar. Upprepa 3 gånger per nivå med randomiserad paus så användaren ser mönstret tydligare.

**2. Automatisk GATT round-trip mätning**
Mät den faktiska GATT `writeValueWithoutResponse` tiden automatiskt (redan i debug-stats som `lastWriteMs`). Använd detta som *startgiss* för binärsökningen istället för hårdkodat 90ms.

**3. Bredare sökintervall + adaptiv start**
Starta med [0, 300ms] och använd GATT round-trip som initial gissning istället för mitten.

**4. Spara per-test-typ i databasen**
Spara `tapLatencyMs` och `metroLatencyMs` separat i `device_calibration` (JSONB) så du kan jämföra och se om de divergerar.

**5. Validerings-test: "Verify sync"**
Efter att latensen sparats, kör en kort verifieringssekvens: 5 synkade blinkar med den sparade kompensationen. Användaren bekräftar "ser synkat ut" eller "fortfarande off". Ger confidence i resultatet.

### Databasändring

Lägg till kolumn `latency_results` (JSONB) i `device_calibration` för att spara detaljerad historik:
```json
{
  "tapMs": 85,
  "metroMs": 90, 
  "gattRoundtripMs": 12,
  "verifiedAt": "2026-03-13T...",
  "verified": true
}
```

### Kodändringar

**`src/pages/Calibrate.tsx` — LatencyTab:**
- Tap-sync: 3 blinkar per runda, bredare intervall [0, 300], GATT round-trip som startgiss
- Metronom: Byt `setInterval` till `setTimeout`-chain för lägre jitter
- Ny "Verifiera"-knapp efter sparning som kör 5 synkade blinkar
- Spara `latency_results` till cloud

**`src/lib/lightCalibration.ts`:**
- Ny `saveLatencyToCloud()` som sparar detaljerade latensresultat

### Sammanfattning av kalibreringsflödet

```text
1. BLE Speed-test     → min intervall (ms)
2. Latens tap-sync    → BLE-fördröjning (ms), 3 blinkar/runda
3. Latens metronom    → BLE-fördröjning (ms), slider-finjustering  
4. Verifiering        → 5 synkade blinkar, bekräfta/justera
5. Allt sparas        → device_calibration (per lampnamn)
```

