
Målet är att kapa tidsfelet mellan ljudinput och faktiskt ljusutfall (färg/ljusstyrka), inte bara minska “hack”.

Plan:

1) Isolera flaskhalsen med lättviktig mätning
- Lägg till intern timing-mätning i kedjan: `mic sample -> beräknad nivå -> köad BLE -> faktiskt skrivintervall`.
- Visa i debug (temporärt): senaste write-interval, writes/sek, droppade/coalescade uppdateringar, uppskattad end-to-end-latens.
- Detta gör att vi kan bekräfta om problemet är ljudpipeline, kö/schemaläggning eller BLE-hårdvarugräns.

2) Bygg om BLE-utmatning till “frame scheduler” (huvudfix)
- Nu skickas färg + brightness varje tick (50 ms), vilket blir upp till ~40 kommandon/s.
- Hårdvaran klarar i praktiken ~20 kommandon/s, så kön blir överbelastad och utfallet blir tidsmässigt fel.
- Ändra till en styrd scheduler:
  - max 1 BLE-kommando per 50 ms,
  - brightness prioriteras kontinuerligt,
  - färg skickas endast vid faktisk ändring (albumfärgbyte, vit-kick in/ut),
  - dedupe/deadband för brightness (t.ex. skicka bara vid meningsfull ändring).
- Resultat: färre men rätt-tajmade kommandon istället för backlogg.

3) Minska jitter i input-ledet
- Sluta läsa kalibrering från localStorage i varje tick; håll kalibrering i minne/ref och uppdatera vid ändring.
- Starta mic med låg-latens audio constraints (stäng av echo cancellation/noise suppression/auto gain där möjligt).
- Behåll RMS + attack/release, men stabilisera uppdateringsfrekvensen så output inte driver efter.

4) Finjustera vit-kick utan att sabba timing
- Behåll 95–100% / 100 ms enligt önskemål.
- Säkerställ att vit-kick inte triggar extra onödiga färgskrivningar varje tick; endast state-transitioner ska skicka färg.

Tekniska detaljer:
- `src/lib/bledom.ts`:
  - ersätt nuvarande “skriv så fort Promise-kedjan tillåter” med tidsstyrd scheduler (50 ms-slot),
  - separata pending-state för brightness/color + prioritering,
  - statistikfält för debug (writes/s, dropped updates, queue age).
- `src/components/MicPanel.tsx`:
  - cachead kalibrering (ref) istället för `getCalibration()` per tick,
  - skicka brightness delta-baserat,
  - skicka färg endast när färgtillstånd faktiskt byter (normal ↔ white kick / ny accentfärg).
- Ev. liten debugvisning (kan vara tillfällig) för att verifiera förbättring objektivt.

Verifiering (end-to-end):
- Testa låg och hög musiknivå samt snabba transienter.
- Bekräfta:
  - jämn uppdatering utan “5-sekunderskänsla”,
  - märkbar minskning i input→ljus-latens,
  - stabil vit-kick på toppar utan extra jitter.
- Jämför före/efter med debug-mått (write rate, queue age, e2e-latens).
