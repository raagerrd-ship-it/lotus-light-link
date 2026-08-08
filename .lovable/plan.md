Plan: Skapa implementeringsbar svensk prompt för Song Studio

Mål
----
Skriva en fristående, svensk, teknisk prompt som beskriver hur den gamla Song Studio-funktionen i lotus-light-link fungerade, från inspelning till energivisning. Prompten ska vara tillräckligt detaljerad för att Claude (eller en annan utvecklare) ska kunna återskapa funktionen i ett nytt projekt.

Bakgrund
--------
Funktionen fanns i lotus-light-link fram till 2026-06-02. Den spelade in ljussekvenser per låt, polerade dem med DSP, spelade upp dem synkat mot Sonos och visade låtenergi samt aktuell position i UI. Källkoden har sedan tagits bort ur projektet enligt projektminnet, men historiken och eventuella kvarvarande fragment i kodbasen kan användas för att rekonstruera beteendet.

Steg
----
1. Rekonstruera arkitekturen
   - Läs relevanta kvarvarande filer (t.ex. pi/src/piEngine.ts, src/pages/PiMobile.tsx, minnesfiler om inspelning) för att hitta referenser och gränssnitt.
   - Läs chatthistoriken kring #7558–#7596 för att återfinna specifikationen för lightRecorder.ts, seqPolish.ts, seqRender.ts, songIdentity.ts, acrIdentify.ts, configServer-endpoints och SongStudio.tsx.
   - Identifiera vilka datastrukturer, API-endpoints och UI-komponenter som behövdes.

2. Definiera omfattningen i prompten
   - Inspelning: vad triggade inspelning (Sonos playbackState, isTvMode, låtnyckel), hur frames sparades, formatet på en frame (tid, färg, brightness pct).
   - Låtidentifiering: nyckel från Sonos-metadata vs ACRCloud-fallback.
   - Polering: fillGaps, smooth, expand, normalize, beat detection, beat emphasis, flicker-mått, före/efter-analys.
   - Uppspelning: synk mot Sonos positionMs, lead-offset, fallback till realtid om ingen sekvens finns.
   - UI: SongStudio-vy med lista, detaljvy, före/efter-diagram, energi-kurva, låtposition, återställning från råfil.
   - Borttaget skäl: varför funktionen togs bort (realtime-only, WiFi/BLE-koexistens, minnesproblem) och varningar om att återinförande kräver omsorg.

3. Skriva prompten på svenska
   - Format: markdown med avsnitt som "Översikt", "Datastrukturer", "Komponenter", "API", "Algoritmer", "UI", "Begränsningar", "Kända fallgropar".
   - Ton: teknisk, koncis, implementeringsbar.
   - Exempel på kodsnuttar där det hjälper läsaren.

4. Leverera som fil
   - Spara prompten som `/mnt/documents/song-studio-prompt.md` så att den kan kopieras och klistras in i Claude.

Verifiering
-----------
- Prompten innehåller alla delar: inspelning, låt-ID, polering, uppspelning, energi/position, UI.
- Prompten är på svenska och kan kopieras rakt av.
- Ingen källkod i lotus-light-link ändras; detta är enbart en dokumentations-artefakt.
