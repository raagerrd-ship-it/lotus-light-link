# FIX 5 — Anti-churn för BLEDOM-lampan

Målet: en deploy-svit ska aldrig kunna hamra lampan med connect/disconnect-cykler så att dess firmware låser sig. Endast tids-spärrar runt connect/disconnect — write-path, ACL-drain, conn-interval-forcering (15 ms) och watchdogen lämnas orörda.

## H1 — Bounded ren disconnect vid shutdown

`pi/src/index.ts`: shutdown-handlern (SIGINT/SIGTERM) väntar i dag på `disconnectHardcoded()` utan tidsgräns, så systemd kan SIGKILL:a mitt i och lampan får ett abrupt tapp.

Åtgärd: kör disconnect via `Promise.race([disconnectHardcoded(), sleep(1500)])`, logga om timeouten vann, och `process.exit(0)` direkt efteråt.

## H2 — Cross-restart connect-cooldown (kärnan)

Ny liten modul i ble-drivern (fristående, bara `node:fs`) som läser/skriver `/tmp/lotus-ble-connect-at`:

- `connectHardcoded()` skriver `Date.now()` till filen vid STARTEN av varje connect-försök (inte per write).
- `toMotorOn()` i `pi/src/engineLifecycle.ts` läser filen före initial `connectHardcoded()`. Om `now - last < 4000 ms`: `await sleep(4000 - elapsed)`.

Effekt: normal omstart (senaste connect timmar gammal) → ingen fördröjning. Snabb deploy-svit → connect-försöken sprids ≥4 s isär. tmpfs → ingen SD-slitage och nollställs vid Pi-reboot, vilket är rätt.

## H3 — Hårt golv mellan connect-försök i samma process

`pi/src/ble-driver/connect.ts` har redan `_lastConnectCallAt` men använder den bara för hammer-varningen. Åtgärd: gör den till en spärr — i början av `connectHardcoded()` (efter in-flight/redan-ansluten-guards) `await sleep()` upp till 2000 ms sedan förra försöket, oavsett väg (HTTP, lifecycle, auto-reconnect-loop).

## H4 — Churn-detektor → lång paus

Håll en liten ring med de senaste connect-tidsstämplarna i `/tmp/lotus-ble-connect-at` (JSON-array, max ~8 poster). Fler än 5 försök inom 30 s → skjut nästa connect ~15 s framåt och logga `ble-churn-guard` via restart-loggen (app-sidan; drivern får en hook likt `setRestartHook` så den förblir importfri).

## Teknisk sammanfattning

- `pi/src/ble-driver/connect-throttle.ts` (ny): `noteConnectAttempt()`, `getCooldownWaitMs(cooldownMs)`, churn-räkning på tmpfs-filen.
- `pi/src/ble-driver/connect.ts`: kalla `noteConnectAttempt()` + hårt 2 s-golv i `connectHardcoded()`; churn-paus innan försöket.
- `pi/src/ble-driver/index.ts`: re-exportera de nya hjälparna.
- `pi/src/engineLifecycle.ts`: ny dep `waitForConnectCooldown()` som `toMotorOn()` awaitar före initial connect.
- `pi/src/index.ts`: bounded disconnect i shutdown + wire:a in cooldown-dep och churn-logg-hook.
- `pi/package.json`: version-bump.

## Verifiering

- Normal omstart: motorn ansluter som förut, ingen märkbar extra fördröjning.
- 3–4 snabba `systemctl restart` → loggen visar cooldown-väntan och connect-försök ≥4 s isär; lampan fortsätter annonsera.
- Deploy: loggen visar ren disconnect före exit (eller "disconnect timeout" efter 1,5 s) i stället för att blockera till SIGKILL.
