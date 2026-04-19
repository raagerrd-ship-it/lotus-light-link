

## Mål
Kortast möjliga latens mic→BLE. Det som spelar roll är inte ALSA vs arecord (5-15ms skillnad är försumbart) — det är pipeline-lagren mellan FFT och BLE-write.

## Var ligger latensen idag?

Pipeline (per frame, 128 samples @ 44.1kHz = 2.9ms hop):
```
Mic → ringbuf → FFT (every 128 samples) → onFFTReady → engine.tickInner → BLE write
  ~3ms        ~0.5ms                       0ms event   ~1-2ms              ~10-20ms BLE
```

Total: **~15-25ms i bästa fall**. BLE-skrivningen är den enskilt största posten — och styrs av tick-rate-slidern.

## Vad ger faktisk vinst (rangordnat)

1. **Sänk tick-rate till 25ms** (om inte redan) — ger 40 pkt/s, max throughput innan BLEDOM disconnectar. Detta är redan default enligt minnet.
2. **Verifiera connection interval 7.5-10ms** via HCI (redan implementerat enligt `connection-optimization`).
3. **Mät faktisk end-to-end latens** — vi gissar nu. Lägg till mätpunkter: timestamp vid `onAudioData` → timestamp vid `protocol.write` → logga delta var 2:a sekund.
4. **Hoppa över FFT helt på rena transient-paths** — för "punch white" och flux-driven puls räcker peak-detektion på råa samples (kan göras var 32:a sample = 0.7ms istället för var 128:e). Det är dock en större omskrivning.

ALSA vs arecord: arecord-subprocess lägger ~5-15ms via pipe-buffring. Native ALSA tar bort det. Men om bygget failar är det inte värt att jaga — gör mätningen först.

## Förslag (i ordning)

**Steg 1 — Mät latensen** (nu, billigt):
- Lägg till `lastAudioTimestamp` i `alsaMic.ts` (sätts i `onAudioData`)
- Lägg till `lastBleWriteTimestamp` i `protocol.ts` (sätts precis innan write)
- Exponera båda via `/api/mic/level` som `audioToBleLatencyMs`
- Visa i UI bredvid ALSA/ARECORD-badgen: t.ex. `ALSA · 18ms`

**Steg 2 — Beslut baserat på mätning**:
- Om latens >30ms och ARECORD aktivt → fixa native ALSA-bygget (vi har redan vendored fork)
- Om latens >30ms och ALSA aktivt → titta på engine.tickInner / BLE-kö
- Om latens <25ms → done, det är så snabbt det blir med BLEDOM

## Filer som ändras (steg 1)
- `pi/src/alsaMic.ts` — exportera `getLastAudioTimestamp()`
- `pi/src/ble/protocol.ts` — exportera `getLastWriteTimestamp()`
- `pi/src/configServer.ts` — lägg till latency i `/api/mic/level`
- `src/components/MicBackendBadge.tsx` — visa `· {ms}ms` efter backend-namnet

Inga nya beroenden, ingen ombyggnad. ~30 rader kod totalt.

