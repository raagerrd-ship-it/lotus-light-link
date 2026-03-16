

## Optimera diagrammets databuffert

### Problem
- `Array.push()` + `slice()` körs 8 ggr/sek och skapar nya array-kopior som belastar garbage collector
- Data lagras i två parallella buffertar (MicPanel + chartStore) även om chartStore bara behövs vid kalibrering

### Åtgärder

**1. Byt till ring buffer (zero-alloc)**
Ersätt push+slice med en cirkulär buffert i både `chartStore.ts` och `MicPanel`:
- Fast array med förallokerade platser
- Skrivpekare som wrappas runt
- `getAll()`-metod som returnerar data i rätt ordning utan att skapa ny array vid varje tick

**2. Rensa chartStore-dupliceringen**
- Låt `MicPanel.samplesRef` vara den enda bufferten
- Exponera den till CalibrationOverlay via en getter istället för att pusha till en separat store varje tick
- Ta bort `pushChartSample()`-anropet från tick-loopen

### Teknisk detalj — ring buffer
```text
slots: [s0][s1][s2]...[s119]
        ^cursor
Varje tick: slots[cursor] = newSample; cursor = (cursor+1) % LEN
Rendering: läs från cursor → runt → cursor-1
```

Ingen `slice()`, ingen ny array, ingen GC-press.

