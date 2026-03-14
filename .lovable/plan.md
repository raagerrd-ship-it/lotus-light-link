

# Konserteffekter bara i curve-läge

## Problem
De nya konserteffekterna (strobe, blackout, palett-rotation, djupare dynamik, starkare puls) körs just nu oavsett om det är en sparad låt eller live-inspelning av en ny. Under en ny inspelning saknas sektioner, drops, beat-grid etc. — effekterna blir oförutsägbara och kan störa.

## Lösning
Omslut alla konserteffekter med `hasCurve`-villkoret som redan finns i tick-loopen. Vid första inspelning (mic-mode) används den enkla AGC-baserade ljusstyrningen utan konserttillägg.

### Ändringar i `src/components/MicPanel.tsx`

**Sektion-skalning (rad ~478-481):** Flytta `brightnessScale`-multiplikatorn in i `if (hasCurve)`. I mic-mode appliceras ingen sektions-skalning (finns inga sektioner ändå).

**Palett-rotation (rad ~483-496):** Redan beroende av `currentSections` som bara finns vid sparade låtar, men wrappa explicit i `hasCurve` för säkerhet.

**Blackout (rad ~498-505):** Wrappa i `hasCurve` — drops finns bara på analyserade låtar.

**Beat-puls med starkare multiplikator (rad ~507-523):** I mic-mode: använd den gamla `* 15` multiplikatorn. I curve-mode: använd `* 30`. Strobe-logiken gätes redan av `sectionParams.strobeOnBeat` men wrappas explicit.

**Hard transition flash (rad ~525-532):** Wrappa i `hasCurve` — transitions finns bara på analyserade låtar.

**Sammanfattning:** En enkel `if (hasCurve) { ... }` runt konserteffekterna, med fallback till enkel sektions- och pulslogik i mic-mode.

