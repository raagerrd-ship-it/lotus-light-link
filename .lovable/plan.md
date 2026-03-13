

## Problem

Crosshair-knappen (kalibrering) kan bara slås **på** — klick sätter alltid en ny kalibreringspunkt. Det finns ingen toggle-logik för att stänga av den.

## Lösning

Ändra `onClick` så att om kalibrering redan är aktiv, rensas den (sätts till `null` och tas bort från localStorage). Om den är inaktiv, sätts en ny kalibreringspunkt som idag.

### Ändring i `src/pages/Index.tsx` (rad 314–319)

```typescript
onClick={() => {
  if (calibration) {
    setCalibration(null);
    localStorage.removeItem("gainCalibration");
    return;
  }
  const vol = nowPlaying?.volume;
  if (vol == null) return;
  const cal = { volume: vol, gain: manualGain };
  setCalibration(cal);
  localStorage.setItem("gainCalibration", JSON.stringify(cal));
}}
```

En enkel toggle — inget annat behöver ändras.

