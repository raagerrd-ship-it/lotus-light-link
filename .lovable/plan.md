

## Plan: Visa input→output-fördröjning i diagnostikgrafen

### Problem
Nuvarande recording samplar `inputRms` och `outputPct` i samma ögonblick (efter BLE-skrivning), så kurvorna ser synkroniserade ut. Den verkliga fördröjningen (mic→ljus) syns inte.

### Lösning
Spara **separata tidsstämplar** för input och output i varje sample:
- `tInput` = tidpunkt då FFT-data anlände (mic-signalen)
- `tOutput` = tidpunkt då BLE-skrivningen gjordes

Grafen plottar sedan input-kurvan mot `tInput` och output-kurvan mot `tOutput`, så man visuellt ser tidsförskjutningen (~10-15ms).

### Ändringar

**1. `pi/src/piEngine.ts`**
- Lägg till `_lastFFTTimestamp` som sätts i `tickInner()` vid ingångspunkten (innan processing)
- Ändra `_recordBuffer`-typen: lägg till `tInput` och `tOutput` (separata tidsstämplar relativt recording-start)
- I `recordSample()`: spara `tInput` = FFT-ankomsttid, `tOutput` = nuvarande tid (efter BLE-send)

**2. `pi/src/alsaMic.ts`**
- Exportera en `getLastFFTTimestamp()` som returnerar `performance.now()` vid senaste FFT-beräkning

**3. `src/pages/PiMobile.tsx`**
- Ändra canvas-ritningen: plotta input-kurvorna (blå/grön) mot `tInput` och output-kurvan (orange) mot `tOutput`
- Lägg till en liten label som visar genomsnittlig fördröjning i ms

### Filer som ändras
1. `pi/src/alsaMic.ts` — exportera FFT-tidsstämpel
2. `pi/src/piEngine.ts` — dubbla tidsstämplar i recording-buffern
3. `src/pages/PiMobile.tsx` — rita kurvor med separata tidsaxlar

