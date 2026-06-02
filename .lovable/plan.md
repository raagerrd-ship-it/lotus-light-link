# Analys: ljud→ljus-kedjan och var CPU slösas

## Nuvarande kedja (uppmätta takter)

```text
ALSA mic (48 kHz)
   └─ FFT hop 480 → ~100 Hz frames ──onFFTReady──▶ onFFTFrame()
                                                      │  (gate 1: tickMs-deadline)
                                                      ▼
                                                  tickInner()  ~33 Hz (tickMs=30)
                                                      │  full beräkning:
                                                      │  norm → bas/disk-mix → tystnadsgate
                                                      │  → EMA-smoothing → dynamics (exp/log)
                                                      │  → transient → floor → perceptual gamma
                                                      │  → deadband → color-fade → kalibrering
                                                      ▼
                                                  sendToBLE()  (gate 2: lease + ACL-outstanding)
                                                      │
                                                      ▼  BLEDOM ~6 paket outstanding-tak
```

Centrala konstanter:
- FFT-takt: ~100 Hz (`HOP_SIZE=480 @ 48 kHz`, `piEngine.ts:62`)
- Tick: `tickMs=30` → ~33 Hz tak (`index.ts:TICK_MS`, `piEngine.ts:445`)
- `slotLeaseMs` golvas till **5 ms** (cadence-cap i praktiken avstängd, `piEngine.ts:437/450`)
- Backpressure kommer från **ACL-outstanding-gaten** (`ACL_MAX_OUTSTANDING=6`, `protocol.ts:195`)

## Var slöseriet uppstår

Det finns **två gates** men de sitter på fel sida om beräkningen:

1. **Gate 1 — bra** (`onFFTFrame`, `piEngine.ts:1087`): släng FFT-frame om `tickMs` inte passerat. Sker FÖRE beräkning → ingen CPU bränns. ✅

2. **Gate 2 — slöseri** (`sendToBLE → leaseAndDrainState`, `protocol.ts:296`): körs EFTER att hela `tickInner` räknat klart. Om BLE är upptaget (lease-lock eller ≥6 outstanding ACL-paket) returneras `'busy'` och **allt arbete kastas** — räknas som `tickAbortBleBusyCount` (`piEngine.ts:1500`). ❌

Det här är exakt vad du såg som "mycket körs inte i takt": vid tick=30 ms (33 Hz) men en BLEDOM som realistiskt orkar ~20–25 paket/s, räknar motorn dynamics (`Math.exp/Math.log`), perceptuell gammakurva, color-fade och kalibrering för var 3:e–4:e frame **i onödan** — resultatet dör i lease/ACL-gaten.

## Förslag: låt BLE-out driva motorns takt

Princip: BLE-readiness är sanningen för om en tick är värd att räkna. Flytta gaten FÖRE den dyra delen.

### 1. Pre-gate i `onFFTFrame` (huvudfix)
Exportera en billig, biverkningsfri readiness-check från `protocol.ts` (t.ex. `canWriteNow()` som returnerar `leaseAndDrainState(now) === 'ready'` utan att räkna stats-spikar). I `onFFTFrame`, efter `tickMs`-deadlinen passerat men FÖRE `tickInner()`:
- om BLE **inte** är redo → räkna ny `tickSkippedBleBusyCount`, uppdatera `_nextTickDeadline` och returnera utan att köra `tickInner`.
- om redo → kör `tickInner` som vanligt.

Effekt: ingen dynamics/gamma/fade-beräkning för frames som ändå inte kan skickas. CPU följer faktisk BLE-throughput.

### 2. Tidsbaserad smoothing-korrekthet
EMA och color-fade får inte desynka när ticks hoppas över. Color-fade är redan tidsbaserad (`piEngine.ts:1472`). EMA-smoothing (`piEngine.ts:1388`) använder precomputed `attackAlpha/releaseAlpha` baserade på fast `tickMs`. När intervallet mellan faktiska ticks varierar, gör attack/release-alpha tidsbaserad (alpha ur faktisk elapsed sedan förra körda tick) så ljusbilden blir identisk oavsett hoppade frames. `onsetBoost`/`dynamicCenter` uppdateras redan @100 Hz i `onFluxReady` och påverkas inte.

### 3. Behåll onset-express-pathen
`onFluxReady`-express-writen (skarpa beat/drop-puls, `piEngine.ts:~711`) ska fortsatt gå direkt men respektera samma readiness-check, så en express-write inte heller bränns i onödan. Den hårda onset-guarden (ABS_FLUX_FLOOR + median×1.6 + energy-gate) lämnas orörd.

### 4. Diagnostik
Lägg till `tickSkippedBleBusyCount` i `bleStats` (state.ts) och exponera i `/status` så vi kan mäta hur många ticks som nu sparas. Förväntan: `tickAbortBleBusyCount` ska gå mot ~0 och ersättas av billiga pre-gate-skips.

## Vad som INTE ändras
- Ingen ändring av ljudbilden/tuning (samma dynamics, gamma, deadband, onset-trösklar).
- Ingen ändring av ACL-taket eller lease-golvet.
- Realtime-arkitekturen (event-driven, ingen setTimeout i FFT-pipen) behålls.

## Teknisk sektion (filer som berörs)
- `pi/src/ble/protocol.ts` — ny exporterad `canWriteNow()` (read-only spegling av `leaseAndDrainState`).
- `pi/src/piEngine.ts` — pre-gate i `onFFTFrame`; tidsbaserad attack/release-alpha i `tickInner`; readiness-check i onset-express-pathen.
- `pi/src/ble/state.ts` — ny `tickSkippedBleBusyCount`-räknare.
- `pi/src/configServer.ts` — exponera nya räknaren i `/status`.
- `pi/package.json` — versionsbump.

## Risk / verifiering
- Risk: tidsbaserad EMA fel-implementerad → ljuset känns segare/snabbare. Mitigeras genom att härleda alpha ur samma `1 - (1-base)^(elapsed/125)`-formel som `computeTickConstants` redan använder, fast med faktisk elapsed.
- Verifiering: bygg, kontrollera att `tickAbortBleBusyCount` faller och `tickSkippedBleBusyCount` stiger i `/status` medan pkt/s mot lampan är oförändrat eller bättre.
