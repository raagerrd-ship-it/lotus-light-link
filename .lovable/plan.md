

## Starkare albumfärger — aggressivare boost

### Problem
Trots senaste ändringen (S≥0.6, L 0.35–0.55) upplever du fortfarande bleka färger. Vid L=0.55, S=0.6 kan färger fortfarande vara halvljusa. Dessutom kan albumomslag med övervägande ljusa/vita ytor fortfarande producera bleka toner.

### Åtgärd — `src/lib/ui/colorExtract.ts`

**1. Hårdare clamp i `boostSaturation`:**
```typescript
// Nuvarande:
const boostedS = Math.max(0.6, Math.min(1, s * 2.5));
const boostedL = Math.max(0.35, Math.min(0.55, l));

// Nytt:
const boostedS = Math.max(0.75, Math.min(1, s * 3.0));
const boostedL = Math.max(0.30, Math.min(0.45, l));
```

- **Saturation**: Min höjs 0.6 → 0.75, multiplikator 2.5 → 3.0. Inga halvmättade färger.
- **Lightness**: Max sänks 0.55 → 0.45, min 0.35 → 0.30. Mörkare, renare toner — inget som liknar vitt.

**2. Höj chroma-filtret ytterligare:**
```typescript
// Nuvarande:
if (max - min < 30) continue;

// Nytt:
if (max - min < 45) continue;
```

Filtrerar bort fler "nästan grå"-pixlar så att bara riktigt färgstarka regioner i bilden bidrar.

**3. Höj luminans-filtret:**
```typescript
// Nuvarande:
if (lum > 240) continue;

// Nytt:
if (lum > 200) continue;
```

Skär bort fler ljusa/vita pixlar redan vid sampling.

### Effekt
- Vid 100% brightness: starka, rena färger direkt på LED:n
- Vid lägre %: färgen blir mörkare (RGB pre-multiplikation fungerar redan korrekt)
- Albumomslag med mycket vitt/ljust ger ändå mättade toner

