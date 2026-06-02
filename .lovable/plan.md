## Mål

Två relaterade fixar i Pi-koden för inspelad ljus-uppspelning, så att uppspelningen blir stabil mot BLEDOM-lampans verkliga uppdateringstakt och att en omspelad/loopad låt inte korrumperar inspelningsbufferten.

## FIX 1 — Decimera färdig sekvens till BLE-takt (`pi/src/seqPolish.ts`)

Problem: vi finslipar @100 fps men BLEDOM (sample-and-hold) klarar bara ~20–40 uppdateringar/s. 100 fps-features (1-frame-attack, 10 ms white-punch) flimrar in/ut fas-beroende.

Lösning — som sista steg i `polish()`:

1. Lägg konstanten nära övriga polish-konstanter (vid rad ~28–37):
   ```ts
   const BLE_FRAME_MS = 33; // ~30 Hz — säker BLEDOM-nivå
   ```
2. Lägg till `decimateToBle(frames, intervalMs)` (återanvänder `medianFrameMs`, `clampPct`, `clamp8`): box-medel per `intervalMs`-bin. Returnerar oförändrad sekvens om den redan är på/under måltakten (`medianFrameMs >= intervalMs * 0.9`).
3. Ändra slutet på `polish()` (rad 436) från:
   ```ts
   return applyBeatEnvelope(softened, beats);
   ```
   till:
   ```ts
   const enveloped = applyBeatEnvelope(softened, beats);
   return decimateToBle(enveloped, BLE_FRAME_MS);
   ```

## FIX 2 — Hantera loop/omspelning under inspelning (`pi/src/lightRecorder.ts`)

Problem: vid omstart av samma låt är `key` oförändrad → `finalizeRecording()` triggas aldrig, så `analysisBuf` fylls på med varv 2 ovanpå varv 1 → bakåt-hopp i tidsstämplar + spök-frames.

Lösning — i `onSonosUpdate`, i positionsankrings-blocket (`if (state.positionMs != null) { ... }`): innan vanlig RESYNC-logik, detektera bakåt-hopp (`extrapolated - reported > 3000 ms`) under pågående inspelning (`recording && !pbActive && currentKey`) och starta en ny take:
- `finalizeRecording()` (sparar bara om minst lika komplett → kort omstarts-take skriver aldrig över ett fullt varv)
- om-ankra `posAnchorMs/posAnchorClock/lastAnchorPos` till `reported`
- `return` (hoppa över resten av uppdateringen)

`currentKey` behålls så den nya bufferten fortsätter på samma låt.

## Build & release

- Bumpa `pi/package.json` version (1.0.430 → 1.0.431).
- `tsc -p tsconfig.json --noEmit` för att verifiera kompilering.
- Påminn om att tagga/publicera ny release så ändringarna kommer med i tarballen (annars skrivs de över vid nästa `/api/update`).

## Tekniska noter

- Inga BLE-filer (`pi/src/ble/**`) berörs → ingen `BLE_BUILD_TAG`-bump krävs.
- Live-beteendet (reaktiv engine) är oförändrat; båda fixarna rör endast inspelnings-/finslipnings-pipelinen.
- `decimateToBle` är idempotent vid redan låg takt, så `revertSequence`/preview påverkas inte negativt.
