

## Historiskt intensitetsdiagram

Lägger till ett linjediagram som visar ljusstyrkan (%) de senaste 5 sekunderna, uppdaterat i realtid.

### Approach

Använder **canvas** direkt (inte Recharts) för prestanda – vi ritar ~60fps i en rAF-loop och vill inte trigga React-renders.

### Ändringar i `src/components/MicPanel.tsx`

1. **Historikbuffert**: Lägg till en ref `intensityHistoryRef` som sparar de senaste ~300 värdena (5 sek × 60fps). Varje frame pushar `pct` till bufferten.

2. **Canvas-element**: Lägg till en `<canvas>` under den befintliga ljusstyrka-baren, med max-width ~320px och höjd ~80px, med rundade hörn och mörk bakgrund.

3. **Rita i loopen**: I samma rAF-loop (efter att `pct` beräknats), rita om canvasen:
   - Rensa canvas
   - Rita en linje genom alla punkter i bufferten (x = tid, y = intensitet 0-100%)
   - Linjen får accent-färg med låg opacity, fylld area under linjen
   - Ingen axeltext – rent visuellt

4. **Throttla ritningen**: Rita canvas max var 3:e frame (~20fps) för att spara CPU.

### Visuell stil
- Halvtransparent bakgrund (`bg-secondary/30`)
- Linjen i `hsl(var(--foreground))` med opacity
- Fylld area under linjen med gradient fade
- Rundade hörn, subtilt – matchar befintlig estetik

