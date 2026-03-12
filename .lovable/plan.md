

# Bakgrundsexekvering av ljusstyrning

## Problem
Appen använder `requestAnimationFrame` för sin huvudloop — den pausas helt när appen inte är synlig (tab i bakgrunden, skärm av, etc.). Det innebär att BLE-kommandon och mikrofon-analys slutar fungera.

## Lösning

### 1. Byt huvudloop från `requestAnimationFrame` till `setInterval` + Web Worker
- Flytta timing-loopen till en **Web Worker** som fortsätter köra även när fliken är i bakgrunden
- Worker skickar `tick`-meddelanden till huvudtråden med jämna intervall (~25ms)
- Huvudtråden processar mikrofon-data och skickar BLE-kommandon vid varje tick
- `requestAnimationFrame` behålls **enbart** för canvas-rendering (chart/viz) — den pausas naturligt när appen inte syns, vilket är önskvärt

### 2. Wake Lock API
- Lägg till `navigator.wakeLock.request('screen')` för att förhindra att skärmen släcks (valfritt, men bra på mobil)
- Hantera re-acquire vid `visibilitychange`

### 3. Behåll mikrofon-strömmen aktiv
- AudioContext + MediaStream lever redan i huvudtråden och fortsätter fungera i bakgrunden så länge fliken inte stängs
- En `setInterval`/Worker-tick säkerställer att analyser-data läses och BLE-kommandon skickas

## Teknisk plan

```text
┌──────────────┐    tick (25ms)    ┌───────────────────┐
│  Web Worker  │ ───────────────▶  │   Main thread     │
│  (timer.js)  │                   │  - Read analyser  │
└──────────────┘                   │  - Send BLE cmds  │
                                   │  - Update refs    │
                                   └───────┬───────────┘
                                           │ rAF (only when visible)
                                           ▼
                                   ┌───────────────────┐
                                   │  Canvas rendering │
                                   │  (chart + viz)    │
                                   └───────────────────┘
```

### Filer att ändra/skapa

1. **`public/tick-worker.js`** — Minimal worker: `setInterval(() => postMessage('tick'), 25)`
2. **`src/components/MicPanel.tsx`**:
   - Skapa Worker i `start()`, ta emot `tick` → kör analysloop
   - Separera canvas-rendering till en egen `requestAnimationFrame`-loop som bara ritar om fliken är synlig
   - Lägg till Wake Lock request/release
3. **`src/pages/Index.tsx`** — Lägg till Wake Lock-hantering (acquire on connect, release on disconnect)

### Vad detta ger
- Ljusstyrning fortsätter köra när appen minimeras, telefonen låses, eller man byter app
- Canvas-rendering pausas automatiskt (sparar batteri) men ljuset lever vidare
- Ingen förändring i beteende när appen är synlig

