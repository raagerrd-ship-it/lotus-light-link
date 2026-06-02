# Inspelad uppspelning: false-beat-grind + vit drop-punch

Slår ihop Claudes prompt med den redan driftsatta v1.0.432-logiken. Synken är redan fixad permanent på enheten (`pb-sync-ms` 50→100 via `PUT /api/playback/sync`), så ingen synk-/engine-kod rörs här.

## Ändringar i `pi/src/seqPolish.ts`

### 1. Beat-trösklar → Claudes värden + ny nivå-grind
- `BEAT_K` 2.0 → **1.8**
- `BEAT_PROMINENCE` 1.5 → **1.4**
- `GRID_ONSET_MIN_REF` 6 → **8**
- Ny konstant `BEAT_MIN_LEVEL = 0.30` (normaliserad ljusnivå 0–1).
- I `detectBeats`: beräkna `pMin`/`pMax`/`pRange` en gång före loopen, och direkt efter tröskel-/refraktär-kollen lägga: `if ((frames[i][1] - pMin) / pRange < BEAT_MIN_LEVEL) continue;` → beats i mörka verser/andningar räknas inte.

### 2. Ersätt drop-logiken med Claudes relativa + 100 % VIT punch
Ta bort nuvarande absoluta `applyDrops` (pct=100, ingen färg) och ersätt med två funktioner:
- `detectDrops(frames, beats)` — relativ detektion mot låtens eget pct-spann:
  - `DROP_PEAK_FRAC = 0.80` (topp ≥ 80 % av spannet)
  - `DROP_LULL_FRAC = 0.55` (medel före ≤ 55 % av toppen ⇒ tydlig dal)
  - `DROP_PRE_WINDOW_MS = 700`, `DROP_REFRACTORY_MS = 4000`
- `applyDropEnvelope(frames, drops)`:
  - `DROP_PREDIP_MS = 120`, `DROP_DARK_PCT = 2` → kort släckning mot svart precis före slaget
  - `DROP_PUNCH_MS = 90` → `pct=100` **och r=g=b=255** (vit punch)
  - `DROP_TAIL_MS = 350` → decay tillbaka mot underliggande nivå
- Alla ms-konstanter skalas via `SAMPLE_INTERVAL_MS` (frame-rate-oberoende). Pre-dip (~120 ms) och punch (~90 ms) är medvetet > BLE-rastret (33 ms) så de överlever decimeringen.

### 3. Ta bort baked offline-lead
- `LEAD_MS` = 25 → **0** (eller ta bort `shiftEarlier`-anropet). All lead styrs nu av `pb-sync-ms` på enheten, ingen dubbelräkning.

### 4. polish()-pipeline
Detektera drops på `softened` (renast dal-kontrast), applicera efter beat-envelopen, behåll `decimateToBle` sist i ljus-bearbetningen:
```text
fillGaps → smooth → expand → normalize → softenNonBeats → applyBeatEnvelope
  → applyDropEnvelope(…, detectDrops(softened, beats)) → decimateToBle
```

## Ändring i `pi/src/lightRecorder.ts`
- `DEFAULT_LEAD_MS` 50 → **100** (parity med lead som redan satts i drift, för nyinstallationer).

## Build & release
- Bumpa `pi/package.json` (→ 1.0.433).
- Verifiera med `npx tsc -p tsconfig.json --noEmit`.
- Publicera ny release så tarballen innehåller ändringarna (annars skrivs de över vid nästa `/api/update`).

## Att känna till
- Befintliga inspelningar får inte nya beat/drop-behandlingen automatiskt — kör revert per låt (renderar om från `.analysis.json`) eller spela in på nytt. Analys-mastern finns kvar.
