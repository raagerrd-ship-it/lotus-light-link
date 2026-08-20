# Synka Lotus-analysatorn med DMX Control master

## Mål
Lotus (`pi/src/audio-analyser/`) ska åter vara en uppdaterad mirror av DMX Controls analysator, så båda projekten analyserar ljud lika bra och Lotus drar nytta av den senaste träningen därifrån.

## Nuvarande läge
- Lotus-analysatorn är en read-only mirror märkt `Synk från commit: ad0e741`.
- Nyligen portade till Lotus: `beatClock.ts`, PLL och grid-driven puls — alla hämtade från DMX Control.
- Användaren har fortsatt utveckla ljusanalysen i DMX Control efter senaste synk, så DMX Control tros ligga före.

## Steg

1. **Identifiera gapet**
   - Läs aktuell DMX Control `pi-dmx/engine/src/analyser.ts` och `beatClock.ts`.
   - Jämför med Lotus `pi/src/audio-analyser/analyser.ts` och `beatClock.ts`.
   - Lista konkreta skillnader: konstanter, algoritmer, nya fält i `Frame`, nya metoder.

2. **Kopiera DMX Control-analysatorn till Lotus**
   - Ersätt `pi/src/audio-analyser/analyser.ts` med DMX Control-versionen.
   - Ersätt `pi/src/audio-analyser/beatClock.ts` om den ändrats.
   - Uppdatera synk-hashen och README/INTEGRATION.md.
   - Behåll Lotus-specifik integration (`EngineConfig` → `AnalyserConfig` är redan isolerat).

3. **Anpassa Lotus-konsumenter**
   - Granska `pi/src/alsaMic.ts` och `pi/src/piEngine.ts` för användning av `Frame`-fält som kan ha ändrats.
   - Uppdatera anrop om nya fält tillkommit eller gamla försvunnit.
   - Säkerställ att `setBeatGrid`, `resetGain`, `setGainLock` fortfarande fungerar som förväntat.

4. **Verifiera**
   - Kör TypeScript-kompilering för `pi/`.
   - Kör eventuella tester.
   - Kontrollera att `/api/status` fortfarande exponerar beat/BPM/intensity/drop-telemetri.

5. **Dokumentera**
   - Uppdatera `.lovable/memory/index.md` med ny synk-status.
   - Skapa/uppdatera minnesfil om nya analysatorfunktioner som påverkar ljusbeteende.

## Framgångskriterier
- `git diff pi/src/audio-analyser/` visar endast Lotus-specifika adapterändringar (ingen semantisk skillnad mot DMX Control).
- `pi/` bygger utan TS-fel.
- `/api/status` rapporterar samma beat/BPM/drop-signaler som före synken.
