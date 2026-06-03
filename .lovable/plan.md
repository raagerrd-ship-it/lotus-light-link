# Två ändringar i Pi-koden

Mål: ta bort den extra BLE-skrivningen vid varje bekräftad onset (hackigt ljus, ingen nytta) och göra ljusuppdateringen lite tätare/mjukare genom att höja default-takt från 30 ms till 25 ms.

## 1. Ta bort onset-express-vägen

**`pi/src/piEngine.ts` (rad ~730–755, i `processOnset`)**

Behåll pulsen som matar den normala tick-vägen:
```text
this.onsetTarget = 0.45;
this.onsetLastFrameIdx = this.onsetFrameCounter;
```

Ta bort:
- Kommentarsblocket `// ── Express path (2026-04-29): sub-frame BLE write …` (rad 733–740).
- Hela `if (this._bleOwner === 'active' && this.lastSentPct >= 0) { … }`-blocket (rad 741–754) som gör `sendToBLE(...)` direkt och räknar upp `onsetExpressCount` / `onsetExpressBusyCount`.

**`pi/src/ble/state.ts` (rad 163–165)**

Ta bort kommentaren `// Sub-frame onset express path …` samt fälten `onsetExpressCount` och `onsetExpressBusyCount` ur `bleStatsState`.

**Ej rörda:** drop-express i `processDrop` (vita punch-blixten, skyddad av `canWriteNow()`) lämnas helt orörd. `processDrop` använder inga onsetExpress-fält.

Efter ändringen ska `grep -rn onsetExpress pi/src src` ge noll träffar.

## 2. Höj default-tickMs till 25

**`pi/src/index.ts` (rad 48)**

Ändra `const TICK_MS = 30;` → `const TICK_MS = 25;` (uppdatera kommentaren till 40 Hz). Logiken som läser sparat `tick-ms` från storage (rad 129) rörs inte — bara fallback-värdet.

**`pi/src/piEngine.ts` (rad 450)**

Ändra konstruktor-defaulten `constructor(tickMs = 20)` → `constructor(tickMs = 25)` för konsekvens.

## Verifiering

- `grep -rn onsetExpress pi/src src` → 0 träffar.
- Bekräfta att Pi-koden kompilerar (inga kvarvarande referenser till de borttagna fälten).
- Drop-express/`canWriteNow()`-vägen finns kvar oförändrad.

Permanent först efter release + `/api/update` på enheten.
