## Mål

Förbättra den **inspelade/uppspelade** ljus-sekvensen (offline-pipelinen i `pi/src/seqPolish.ts`, full lookahead) + uppspelnings­vägen, på fyra punkter så den känns minst lika bra som realtime:

1. Synk ~25 ms tidigare (ljuset leder ljudet).
2. Striktare false-beat-filter.
3. Drops: lampan dippar kort på breaken precis före dropet → slår till 100 % för max effekt.
4. Vid uppspelning av sparad låt: skicka **alla** frames till BLE, rensa inte bort nästan lika.

Ändringar i `pi/src/seqPolish.ts` (1–3 + decimerings­justering) och `pi/src/piEngine.ts` (uppspelnings-stegning). Live/realtime-reaktiva pathen lämnas i övrigt orörd.

## FIX 1 — Lead ~25 ms i den renderade sekvensen

Offline-render känner hela låten → baka in lead i den polerade sekvensen.

- Ny konstant: `const LEAD_MS = 25;`
- Sista steg i `polish()`: hjälpfunktion `shiftEarlier(frames, ms)` drar varje frames `tMs` tidigare med `LEAD_MS`, klampat till ≥ första tidsstämpeln (ingen negativ tid).

## FIX 2 — Striktare false-beat-filter (`detectBeats`)

- `BEAT_K` 1.6 → 2.0
- `BEAT_PROMINENCE` 1.25 → 1.5
- `BEAT_FLUX_FLOOR_REF` 8 → 12
- Utöka strikta lokala-topp-testet från ±2 → ±3 frames.

Ger även renare `buildBeatGrid` (samma beats som grund).

## FIX 3 — Drop-detektion: pre-dip på break + 100 % punch

Ny `applyDrops(frames, beats)` i `polish()`, efter `applyBeatEnvelope`, före decimering. Med lookahead:

1. Detektera drop: grid-beat där brightness går från en relativ break (lågt medel ~300 ms före) till nära toppen, dvs pct-hopp ≥ ~45 enheter och topp ≥ ~85.
2. Pre-dip: ramp ned mot `FLOOR_PCT` under ~150 ms precis före dropet ("släcks kort").
3. Punch: `pct = 100` på drop-framen + kort svans (~120 ms) nära 100.
4. Refraktär: minst ~2 s mellan drops så vanliga beats inte triggar.

Fönster i ms → frames via befintlig `SAMPLE_INTERVAL_MS`.

## FIX 4 — Skicka alla frames vid uppspelning, rensa inte nästan lika

Två orsaker till att sparat läge "rensar" detaljer idag:

1. **`decimateToBle` box-medlar** → snabba punch-/drop-frames slätas ut. Ändra brightness-aggregeringen till **peak-bevarande** (max pct i binet) medan färg fortsatt medel-värdas. Då matchas BLE-takten men punch/drop överlever.
2. **`playbackTick` position-samplar** vid tickMs → kan hoppa över/upprepa lagrade frames. Ändra uppspelningen så den **stegar igenom varje lagrad frame i tur och ordning** (frame-stegning ankrad mot position) så varje frame skickas en gång. Ingen deadband/no-change-rensning i uppspelnings-pathen (deltaskip i `protocol.ts` är redan av).

Notera: eftersom sekvensen redan ligger på BLE-takt (~30 Hz) ger "skicka alla" ingen flimmer-risk — den matchar lampans verkliga uppdaterings­takt.

## Pipeline-ordning i polish()

```text
fillGaps → smooth → expand → normalize → softenNonBeats
  → applyBeatEnvelope → applyDrops → decimateToBle(peak-bevarande) → shiftEarlier
```

## Build & release

- Bumpa `pi/package.json` (1.0.431 → 1.0.432).
- `tsc -p tsconfig.json --noEmit`.
- Påminn om att tagga/publicera release så ändringarna kommer med i tarballen.

## Tekniska noter

- `seqPolish.ts` (DSP) + `piEngine.ts` (uppspelnings-stegning) ändras. Inga BLE-protokoll-filer → ingen `BLE_BUILD_TAG`-bump.
- Drop-pre-dip är äkta anticipation (offline lookahead).
- Lead bakas i sparad sekvens; engineens playback-lead/auto-sync verkar additivt och rörs inte.
- Slår igenom vid om-rendering: nya inspelningar + `revertSequence`/finalize som kör `polish()`.
