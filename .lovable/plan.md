

## Problem: "Spara latenskompensation"-knappen går inte att trycka på

### Orsak
Sidan har `pb-[max(1rem,env(safe-area-inset-bottom))]` som padding i botten. På en 594px viewport hamnar sammanfattningssektionen (med spara-knappen) längst ner och kan täckas av:
1. Webbläsarens bottom bar (iOS Safari) eller system UI
2. Otillräcklig scroll-padding — knappen syns men touch-ytan blockeras

### Fix

**`src/pages/Calibrate.tsx`** — Två ändringar:

1. **Lägg till `pb-24`** på ytterdiven (rad 704) så att det finns gott om utrymme att scrolla förbi sista elementet.

2. **Flytta spara-knappen uppåt i layouten** — gör den `sticky bottom-4` så den alltid är synlig och klickbar när `bestResult` finns, oavsett scrollposition.

Alternativt, det enklaste: bara ökad bottom-padding + en extra `mb-16` på LatencyTab-wrappern så knappen aldrig hamnar under safe area.

