

## Mål
1. Visuella staplar i `MicBackendBadge` istället för flimrande siffror.
2. Räkna **alla** skip-typer separat så inget göms.

## Räknare vi ska visa (alla per sekund)

Backend redan har eller behöver:
- `fftPerSec` — FFT-frames producerade
- `tickPerSec` — engine-ticks körda
- `sentPerSec` — BLE-paket faktiskt skickade
- `skipDeltaPerSec` — skippade pga oförändrad färg (förväntat)
- `skipRateLimitPerSec` — skippade pga 35ms-gate (BLE cap nådd, förväntat)
- `skipInFlightPerSec` — skippade pga write hänger (verklig kö — onormalt) **[NY]**
- `writeFailPerSec` — writeAsync kastade error **[NY: derive från writeFailCount]**
- `fftDroppedPerSec` — FFT-frames som kom innan tick-fönstret öppnat (extra mic-input som bara uppdaterar FFT-state) **[NY]**

Backend-ändring: splitta `skipBusyCount` i `skipInFlightCount` + `skipRateLimitCount` (i `pi/src/ble/protocol.ts` + `state.ts`), räkna `fftDroppedCount` i `piEngine.ts`, exponera alla via `/api/mic/level`.

## UI-design (kompakt, inom befintlig badge-höjd)

```
[ALSA · 18ms]  ▮▮▮ ▮▮▮ ▮▮▮ · ░░▮ ▮▮░ · ●
                FFT TCK PKT   DLT RLM   ↑ skip-LED (in-flight/fail)
```

Tre **gröna staplar** = produktiva: FFT / TICK / PKT, var och en normaliserad mot sitt mål (`fftMål = 2000/tickMs`, `tickMål = pktMål = 1000/tickMs`).

Två **grå/blå staplar** = förväntade skips: DLT (delta) och RLM (rate-limit). Höjd = `skipPerSec / pktMål` (visar hur stor andel av tick-budgeten som "sparades").

En **röd LED-prick** lyser bara när `skipInFlight > 0` ELLER `writeFail > 0` ELLER `fftDropped > 0` under senaste sekunden — det är de OND skipsen som betyder verklig kö eller missad capacity.

Färglogik per stapel:
- ≥80% av mål → primary (grön/blå)
- 40–80% → foreground/70
- <40% → destructive

Tooltip: full siffer-readout för alla räknare, plus förklaring (hold-to-read).

CSS-baserade staplar (`<div>` med `height: %`), ingen ny dep. ~60 rader total.

## Filer
- `pi/src/ble/state.ts` — lägg `skipInFlightCount`, `skipRateLimitCount`, `fftDroppedCount`
- `pi/src/ble/protocol.ts` — bumpa rätt räknare i båda gates
- `pi/src/piEngine.ts` — bumpa `fftDroppedCount` när FFT kommer för tidigt
- `pi/src/configServer.ts` — exponera nya `*PerSec`-fält i `/api/mic/level`
- `src/components/MicBackendBadge.tsx` — byt textraden mot stapel-rad + skip-LED, behåll latens-suffix och tooltip

