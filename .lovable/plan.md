

## Plan: Dynamik-dämpning ("Headroom"-reglage)

### Vad det gör
Ett reglage som gör det svårare för ljuset att nå full intensitet. Tekniskt appliceras en power-kurva på den beräknade ljusstyrkan: `output = (input)^exponent`. Med exponent > 1 krävs starkare signal för att nå toppen — låga/medelintensiteter trycks ner medan max fortfarande är nåbart vid riktigt kraftiga slag.

### Reglage
- **Slider i headern** bredvid befintliga max-brightness-slidern
- Värden: 1.0 (ingen dämpning, linjärt) → 3.0 (kraftig dämpning)
- Default: 1.0
- Sparas i localStorage
- Visas som "Dämpa" i debug-overlayen

### Teknisk ändring

**`src/components/MicPanel.tsx`** — ny prop `dynamicDamping: number`
- I `computeBrightness()`, efter totalPct beräknas (rad ~680):
```ts
// Apply dynamic damping curve
totalPct = 100 * Math.pow(totalPct / 100, dynamicDampingRef.current);
```
Detta körs före cap/clamp, så maxBrightness och sectionBehavior fortfarande gäller.

**`src/pages/Index.tsx`**
- Ny state `dynamicDamping` med localStorage-persistens (default 1.0)
- Ny slider i brightness-slider-raden: "Dämpa 1.0x–3.0x", steg 0.1
- Skickas som prop till MicPanel

**`src/components/DebugOverlay.tsx`**
- Visa nuvarande damping-värde

### Effekt
- Damping 1.0: Ingen skillnad, allt som idag
- Damping 1.5: Mjukare respons, kräver ~40% mer energi för peak
- Damping 2.0: Ännu plattare, bara riktiga slag når toppen
- Damping 3.0: Extremt dämpad, nästan bara drops/punch når högt

