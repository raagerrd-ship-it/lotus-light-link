# Dedikerad Pi Zero 2W — maximal optimering av motorn

Målet: en Pi Zero 2W som kör *bara* Lotus-motorn, så optimal som möjligt. Ingen ny funktionalitet — vi tar bort dubbelarbete, ger motorn prioritet och gör kostnaden mätbar så vi kan live-trimma.

## Vad som kostar mest idag (verifierat i koden)

Motorn kör **två parallella ljudpipelines** på samma mikrofonström:

```text
ALSA 48 kHz
 ├─ legacy-pipe:   1024-FFT var 480:e sample  → 100 Hz  (fftRadix2 + bands + flux)
 └─ analysator:     512-FFT var 128:e sample  → 375 Hz
                   2048-FFT var 3:e hop       → 125 Hz  (BIG_EVERY=3)
```

Legacy-pipen står ensam för ~10 % CPU (enligt kommentaren i `alsaMic.ts`) och gör i praktiken en delmängd av vad analysatorn redan räknar ut. Att driva motorn från *en* pipeline är den enskilt största vinsten.

Dessutom finns en **dubblerad playback-watchdog**: samma logik registreras två gånger i `index.ts` (rad ~405 och ~449), båda med 2-sekunders intervall — dubbla timers och risk för dubbel `exit(1)`.

## Plan

### 1. En enda ljudpipeline
- Låt `piEngine` drivas av analysatorns frames (band/nivå/flux finns redan där) i stället för legacy-1024-FFT:n.
- Ta bort legacy-FFT:n i `alsaMic.ts` (`fft1024`, hann-fönstret, ringbuffer-hopen på 480) och filen `fftRadix2.ts` när inget mer använder den.
- Behåll `onFFTReady`/`onFluxReady` som API-yta men mata dem från analysatorn, så `piEngine` och `configServer` inte behöver skrivas om.
- Tick-takten (25 ms) och all kalibrering rörs inte.

### 2. Rensa dubblerad watchdog
- Behåll en playback-watchdog (den senare, som även försöker mjuk BLE-återanslutning via `scheduleAutoReconnect`) och ta bort den första kopian.

### 3. Färre timers
- Slå ihop de fristående `setInterval`-loopar (watchdog, spotify-features-poll, save-timer, sonos stale-watchdog) till en gemensam 1 Hz-scheduler som anropar respektive steg. Färre timer-wakeups = mindre jitter i tick-loopen.

### 4. Ge motorn prioritet i systemd
I `setup-lotus.sh` (engine-servicen):
- `Nice=-10`, `IOSchedulingClass=realtime`, `CPUSchedulingPolicy=other` (undviker RT-svält på 4 svaga kärnor).
- `CPUAffinity=2 3` för motorn så nätverk/UI/systemd-brus hamnar på kärna 0–1.
- Behåll `--max-old-space-size=224`; lägg till `--max-semi-space-size=8` för färre men billigare scavenges.

### 5. Mätbarhet för live-trimning
- Utöka `/api/status` med: event-loop-lag (EMA + max), tick-jitter (avvikelse från 25 ms) och FFT-frames/s — utöver befintlig `analyserCost`.
- Visa de tre värdena i PiMobile-statusraden så du ser direkt i ladan om något går över budget.

### 6. OS-noteringar (körs på Pi:n, inte i koden)
Läggs som en checklista i `pi/README.md`:
- `wifi powersave off`, avstängd `bluetooth`-scanning-brus, `gpu_mem=16`, inga onödiga tjänster (avahi/triggerhappy), swap 512 MB (redan dokumenterat).

## Teknisk sammanfattning
Filer som berörs: `pi/src/alsaMic.ts`, `pi/src/piEngine.ts`, `pi/src/index.ts`, `pi/src/configServer.ts`, `pi/setup-lotus.sh`, `pi/README.md`, borttag av `pi/src/fftRadix2.ts`. Ingen ändring av kalibreringsvärden, BLE-protokoll eller analysatorns interna konstanter (`BIG_EVERY=3`, 375 Hz hop).

Verifiering: `cd pi && npm run build` samt att `/api/status` visar `analyserCost.msEMA` under budget (2.67 ms/hop) och stabil tick-jitter på Pi:n.
