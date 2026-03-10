

## Mjukare fade-tillbaka

Höjer target-nivåerna och ökar antalet beats som faden sträcker sig över, så ljuset aldrig tappar lika djupt och återhämtar sig långsammare.

### Ändringar i MicPanel.tsx (rad 227-231)

Nuvarande värden → Nya värden:

| Parameter | Nu | Nytt |
|---|---|---|
| `targetLevel` vid 60 BPM | 0.15 | 0.35 |
| `targetLevel` vid 200 BPM | 0.60 | 0.75 |
| `spanBeats` vid 60 BPM | 2 | 3 |
| `spanBeats` vid 200 BPM | 4 | 6 |

Konkret:
```typescript
const targetLevel = 0.35 + bpmFactor * 0.4;  // 0.35 → 0.75
const spanBeats = 3 + bpmFactor * 3;          // 3 → 6 beats
```

Detta ger en märkbart mjukare, mer sustained fade som aldrig går ner till nära-noll.

