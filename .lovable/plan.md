

# Debug-overlay för synkdata

## Vad
Ett litet halvtransparent overlay i hörnet som visar realtidsdata: smoothedRtt, autoDriftMs, syncOffsetMs, och aktuell sektion. Togglas med trippelklick eller liknande.

## Hur

### Ny komponent: `src/components/DebugOverlay.tsx`
Enkel komponent som tar props: `smoothedRtt`, `autoDriftMs`, `syncOffsetMs`, `currentSection` (string | null). Renderar en fixed-position `div` i nedre vänstra hörnet med monospace-text, halvtransparent bakgrund.

### MicPanel: exponera aktuell sektion
MicPanel behöver rapportera `currentSection` uppåt. Lägger till en ny callback-prop `onSectionChange?: (section: SongSection | null) => void` som anropas när sektionen ändras i renderloopen.

### Index.tsx
- Ny state: `currentSection` + `showDebug`
- Trippelklick på bakgrunden togglar `showDebug`
- Rendera `<DebugOverlay>` villkorligt

