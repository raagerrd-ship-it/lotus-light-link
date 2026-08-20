---
name: Runtime-hälsa och gemensam 1 Hz-scheduler
description: /api/status.runtime exponerar fftFps, loopLagMs och tickJitterMs för live-trimning; alla sekund-uppgifter körs från EN 1 Hz-timer i index.ts (everySeconds).
type: feature
---
**Beslut (2026-08-20, dedikerad Pi Zero 2W):**

**1. En timer istället för flera.** `pi/src/index.ts` har en `everySeconds(n, fn)`-scheduler ovanpå EN `setInterval(1000)`. Watchdog (2s), spotify-poll (5s) och runtime-sampling (1s) körs där. Lägg ALDRIG till nya fristående `setInterval` för sekund-uppgifter — varje timer är en extra wakeup som ger tick-jitter på svaga kärnor.

**2. Mätvärden (`pi/src/runtimeHealth.ts` → `/api/status.runtime`):**
- `fftFps` — ska vara ~80 (HOP=600 @ 48kHz). Lägre = ALSA tappar samples.
- `loopLagMsEMA/Max` — hur sent 1s-timern kommer. Max > 100 = något tungt delar kärna.
- `tickJitterMsEMA/Max` — avvikelse från tickMs. Höga toppar = ryckigt ljus.
Max-värdena nollställs vid läsning (peak sedan förra hämtningen). CPU-% är inte ett användbart mått — ALSA kapar buffern tyst långt innan CPU:n ser mättad ut.

**3. systemd-prioritet** (`setup-lotus.sh`): `Nice=-10`, `IOSchedulingClass=best-effort` + prio 0, utöver befintliga `CPUAffinity`/`AllowedCPUs`. Inte `IOSchedulingClass=realtime` — kräver mer privilegier än servicen har.

**4. OS-checklista** för färsk install finns i `pi/README.md` (wifi powersave av, gpu_mem=16, journal volatile, setcap på hcitool).

**Filer:** pi/src/runtimeHealth.ts, pi/src/index.ts (scheduler), pi/src/piEngine.ts (noteTick), pi/src/configServer.ts (status), pi/setup-lotus.sh, pi/README.md.
