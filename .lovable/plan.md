

# Logaritmisk brightness-mapping — aldrig "dött"

## Problemet
Nuvarande `computeBrightness()` mappar linjärt från energi till brightness med ett golv på 10% (`FLOOR = 0.10`, `pct = max(3, ...)`). Lugna partier hamnar nära 3–10% vilket känns dött/avstängt.

## Lösningen
Ersätt den linjära `floored → pct` mappningen med en logaritmisk kurva som mappar **0 → 10%** och **1 → 100%**, så att även tyst musik ger synlig aktivitet.

### Formel
```text
pct = 10 + Math.round(90 * Math.log1p(floored * 9) / Math.log(10))
```
- `floored = 0.0` → `log1p(0)/log(10) = 0` → **10%**
- `floored = 0.1` → ~**27%**
- `floored = 0.3` → ~**50%**  
- `floored = 0.5` → ~**64%**
- `floored = 1.0` → ~**100%**

Lugna partier arbetar i 10–50%-zonen istället för 3–10%.

## Ändring i `src/components/MicPanel.tsx`

### `computeBrightness()` (rad 447–448)
Ersätt:
```typescript
const floored = Math.max(FLOOR, finalCurved);
const pct = Math.max(3, Math.round(floored * 100));
```
Med:
```typescript
const floored = Math.max(0, finalCurved);
const pct = Math.round(10 + 90 * Math.log1p(floored * 9) / Math.log(10));
```

`FLOOR`-konstanten (rad 233) kan tas bort eller behållas som referens. Golvet är nu inbyggt i log-kurvan (10%).

