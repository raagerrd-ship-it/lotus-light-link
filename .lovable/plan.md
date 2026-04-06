

# Realtids-visualisering i Pi Mobile UI

## Är det för komplext för Pi?

Nej. Pi:n har redan all data — `piEngine.ts` emittar `brightness`, `bassLevel`, `midHiLevel` varje tick (25–33ms). Vi behöver bara:
1. Ett SSE-endpoint som streamar tick-data till mobilen
2. En enkel canvas-rendering i HTML-filen

Canvas-rendering av ~64 punkter är trivialt för en mobils webbläsare. SSE kostar nästan ingenting på Pi:n.

## Vad som byggs (mockup i Lovable)

En kompakt canvas-visualisering på **startskärmen** i PiMobile som visar:
- **Heldragen linje**: Bearbetad brightness (efter alla sliders)
- **Streckad linje**: Rå energi (före slider-bearbetning)

Simulerad data med sinusvåg + brus som reagerar på slider-ändringar i realtid, så du kan se hur attack/release/damping/smoothing påverkar kurvan direkt.

## Filer

| Fil | Ändring |
|-----|---------|
| `src/pages/PiMobile.tsx` | Lägg till simulerad ljudmotor + canvas-chart på startskärmen |

## Mockup-layout

```text
┌──────────────────────────┐
│  🟢 Lotus Light      ⚙️  │
├──────────────────────────┤
│  BLE: 2 st   Sonos: ▶   │
├──────────────────────────┤
│  ┌──────────────────────┐│
│  │ ~~~~~ chart ~~~~~~~ ││  ← ~80px hög canvas
│  └──────────────────────┘│
├──────────────────────────┤
│  ┌──────┐  ┌──────┐     │
│  │ Lugn │  │Normal│     │
│  ├──────┤  ├──────┤     │
│  │Party │  │Custom│     │
│  └──────┘  └──────┘     │
├──────────────────────────┤
│  ■ Idle-färg    [R G B]  │
└──────────────────────────┘
```

## Simuleringslogik

En `useEffect` med `setInterval` (25ms) genererar en sinusvåg med brus som basenergi. Slidervärden (attack, release, smoothing, dynamicDamping) appliceras i realtid på signalen, precis som i den riktiga motorn. Resultatet pushas till en ringbuffer och ritas med en enkel canvas-loop.

## För Pi-deploy (senare steg)

Byter ut simuleringen mot ett SSE-endpoint:
```
GET /api/stream → Server-Sent Events med { brightness, rawPct, bass, midHi } varje tick
```

Pi:ns `configServer.ts` får ett `app.get('/api/stream', ...)` som prenumererar på `engine.onTick()`.

