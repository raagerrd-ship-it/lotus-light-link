

## Starkare albumfärger — mindre bleka/vita

### Problem
`boostSaturation` tillåter lightness upp till 65% (`boostedL max 0.65`) och saturation ner till 0.4. Det ger bleka, nästan vita toner — särskilt på ljusa albumomslag.

### Åtgärd — `src/lib/ui/colorExtract.ts`

Ändra `boostSaturation`-funktionens clamp-värden:

```typescript
// Nuvarande:
const boostedS = Math.max(0.4, Math.min(1, s * 2.0));
const boostedL = Math.max(0.45, Math.min(0.65, l));

// Nytt:
const boostedS = Math.max(0.6, Math.min(1, s * 2.5));
const boostedL = Math.max(0.35, Math.min(0.55, l));
```

**Effekt:**
- **Saturation**: Minimum höjs 0.4 → 0.6, multiplikator 2.0 → 2.5. Inga bleka/gråa färger slipper igenom.
- **Lightness**: Max sänks 0.65 → 0.55, min sänks 0.45 → 0.35. Mörkare, mer mättade toner istället för pastellvitt.

Dessutom höja chroma-filtret i `extractColorsFromImage` från `max - min < 15` till `< 30` för att filtrera bort fler gråaktiga pixlar innan de ens når boosting.

