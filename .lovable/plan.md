

## BLE-hastighetstest: Mät verklig genomströmning utan köbildning

### Problem
Nuvarande test skickar 3 pulser med fast längd och frågar "såg du alla?". Men `writeValueWithoutResponse` returnerar direkt — den *buffrar* kommandot. Lampan kan visa alla 3 blinkar trots att de köades. Vi mäter alltså inte verklig genomströmning, utan bara om lampan till slut bearbetar kön.

### Ny approach: Round-trip timing

Istället för att fråga användaren mäter vi **hur lång tid varje BLE-skrivning faktiskt tar**. När lampan hinner med returnerar `writeValueWithoutResponse` snabbt (~2-5ms). När kön bildas börjar returntiden öka — det är tecknet på att vi skickar för snabbt.

**Algoritm:**
1. Skicka en serie kommandopar (färg + brightness) med minskande intervall (100ms → 80 → 60 → 50 → 40 → 30 → 20ms)
2. För varje intervall, skicka 10 kommandopar och mät `writeValueWithoutResponse`-tiden för varje
3. Om medel-skrivtiden överstiger ett tröskelvärde (t.ex. > intervall × 0.8) eller om max-skrivtid spiker, har vi hittat gränsen
4. Resultatet: det kortaste intervallet där skrivtiderna förblir stabila

**Visuell bekräftelse:** Under testet visas lampan i R→G→B-cykel så användaren ser att lampan reagerar. Efter det automatiska testet frågar vi: "Såg du snabba, jämna färgbyten?" som en enkel ja/nej-verifiering.

### Ändringar

| Fil | Vad |
|---|---|
| `src/pages/Calibrate.tsx` | Ersätt hela `BleSpeedTab` med ny komponent. Ta bort `TestMode`, modväljare, `PULSE_DURATIONS`, fråga-svar-loop. Nytt: ett enda "Starta test"-knapp → automatisk ramp-down → resultat med graf. |

### Ny BleSpeedTab-logik

```text
[Starta test]
    ↓
intervall = 100ms
    ↓
┌─ loop: skicka 10 st färg+brightness-par ─┐
│  mät writeTime för varje                  │
│  visa live-progress + lampan blinkar      │
└───────────────────────────────────────────┘
    ↓
writeTime stabil? → sänk intervall (−10ms eller −20ms)
writeTime spikar?  → gränsen hittad
    ↓
Visa resultat: "Din lampa klarar Xms intervall"
+ enkel fråga: "Reagerade lampan jämnt?" (ja/nej)
    ↓
[Spara kalibrering]
```

### UI
- **Progressbar** under testet som visar aktuellt testintervall
- **Live-tabell** med kolumner: Intervall | Medel write-tid | Max write-tid | Status (✓/✗)
- **Resultat:** "Optimalt intervall: **X ms** (Y kommandon/sek)" + spara-knapp
- Enda läge — alltid färg + brightness (matchar verklig användning)

### Tröskelvärden
- Stabilt = medel-skrivtid < 50% av intervallet OCH max < 80% av intervallet
- Kör 10 skrivningar per intervallsteg, ignorera första 2 (uppvärmning)
- Steg: 100, 80, 60, 50, 40, 35, 30, 25, 20ms

