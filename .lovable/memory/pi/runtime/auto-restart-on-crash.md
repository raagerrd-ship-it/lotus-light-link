---
name: Auto-restart hela kedjan vid ofrivillig död
description: /tmp-flagga sätts vid lyckad BLE-connect. Vid systemd-restart (OOM, crash, BLE-fail) startas motor + mic + sonos + lampa automatiskt. Graceful UI-shutdown rensar flaggan.
type: feature
---

## Problem
Tidigare auto-restartade endast scenariot "2 consecutive BLE-failures" (`connect-hardcoded.ts` → `setReconnectOnBootFlag()` → `process.exit(0)`). Andra dödsorsaker — systemd `MemoryMax`-kill, segfault i `alsa-capture`, `uncaughtException`, oväntad SIGTERM — startade om processen via systemd `Restart=always`, men då satt motorn och väntade på att UI skulle trycka "Starta".

## Lösning
**Belt-and-suspenders med /tmp-flagga (`/tmp/lotus-auto-reconnect-on-boot`):**

1. **Sätts** vid första lyckad BLE-connect (markerar "vi var igång — om vi dör innan graceful shutdown, starta om allt"). Hooken sitter i `setEngineBleCallbacks`-wrappern i `pi/src/index.ts` `main()`.
2. **Sätts även** av `connect-hardcoded.ts` vid 2 consecutive failures (befintlig path) och av `uncaughtException`/`unhandledRejection`-handlers innan exit(1).
3. **Konsumeras** vid boot i `index.ts`. Om flaggan finns startas hela kedjan automatiskt i samma ordning som UI:s "Starta allt":
   - `startBleEngineMinimal()` → `startMicSubsystem()` → `startSonosSubsystem()` → 1.5s delay → `connectHardcoded()`
4. **Rensas** av graceful shutdown (SIGINT/SIGTERM från UI-knapp). Förhindrar auto-start efter avsiktlig stop.

## setEngineBleCallbacks-wrapping
`startMicSubsystem` registrerar engine-callbacks via en lokal setter `(globalThis as any).__lotusSetEngineCb`, som main() har registrerat och som wrappar engine-cb tillsammans med flagg-hook. Detta håller flagghanteringen separat från engine-state utan att klippa varandra.

## Verifiering
- Kill -9 på processen mitt i låt → systemd restart → flaggan finns → hela kedjan auto-startar inom ~5s (motor) + ~3s (mic) + ~2s (sonos) + 1.5s + connect = ~10-15s till lampan lyser igen.
- Manuell stopp via UI-disconnect → flaggan rensas → nästa systemd-start väntar på UI som vanligt.
- BLEDOM tappar länken → befintlig auto-reconnect-loop tar över (separat från denna mekanism).
