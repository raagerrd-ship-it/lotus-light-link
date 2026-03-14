

# Återställ diagrammet i cirkeln + basspuls

## Problem
Diagrammet (canvas) renderas nu som en fullskärms-canvas och "solen" är en separat 120px div. Tidigare var diagrammet inuti en cirkulär container som pulserade — nu är de separata element och solen är för liten/svag för att synas tydligt.

## Lösning
Återställ den ursprungliga layouten: en cirkulär container i mitten som innehåller diagrammet (canvas), och hela cirkeln pulserar med basen.

### Ändringar i `src/components/MicPanel.tsx`

**Rendering (rad ~713-733):**
- Wrappa canvas inuti en cirkulär div med `overflow: hidden` och `border-radius: 50%`
- Cirkeln (sunRef) blir containern — ca 55vw bred/hög, centrerad
- Canvasen renderas *inuti* cirkeln, fyller hela den
- Ta bort den separata sun-diven

**RAF-loopen (rad ~293-319):**
- Behåll bass-driven pulsering på sunRef (som nu är cirkel-containern)
- `scale`, `box-shadow` och `background` appliceras på samma element som innehåller canvasen
- Canvas-storlek justeras till cirkelns storlek istället för `window.innerWidth/Height`

**Canvas resize (rad ~699-709):**
- Ändra resize-logiken så canvasen matchar cirkelns storlek, inte hela fönstret

Resultat: Diagrammet ritas inuti cirkeln, och hela cirkeln pulserar med basen — exakt som innan.

