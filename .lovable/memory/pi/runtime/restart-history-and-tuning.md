---
name: Restart-historik på disk + UI-vy
description: Ringbuffer (50 entries) i DATA_DIR/restart-log.json med reason, uptime, RSS. Exponeras via /api/status.restarts. UI visar lista med tidsstämpel och dominerande reason.
type: feature
---

## Syfte
Ge synlighet i HUR OFTA och VARFÖR motorn startar om så vi kan tunea (CONSECUTIVE_FAIL_LIMIT, MemoryMax etc) istället för att gissa.

## Loggade orsaker (`pi/src/restartLog.ts`)
- `ble-consecutive-failures` — `CONSECUTIVE_FAIL_LIMIT` (4) nått i `connect-hardcoded.ts`
- `uncaught-exception` — process.on('uncaughtException') i `index.ts`
- `unhandled-rejection` — process.on('unhandledRejection') i `index.ts`
- `unknown-systemd-restart` — föregående process dog utan att hinna logga reason (OOM-kill, segfault, kill -9). Detekteras via SESSION_MARKER-fil som rensas av graceful shutdown.
- `manual-restart` — reserverad för framtida UI-knapp

## Detection-logik
- `noteBootStart()` vid uppstart i `index.ts`: om `<DATA_DIR>/.lotus-session-alive` finns kvar OCH ingen ny entry loggats inom 5s → `unknown-systemd-restart` (täcker OOM/segfault).
- `markSessionAlive()` vid lyckad BLE-connect → uppdaterar marker så `uptimeBeforeMs` blir korrekt.
- `markGracefulShutdown()` vid SIGINT/SIGTERM → tar bort marker så nästa boot inte loggar falsk unknown.
- `recordRestart(reason, detail)` skriver entry inkl `process.memoryUsage().rss` och uptime sedan marker.

## Ringbuffer
- Plats: `<DATA_DIR>/restart-log.json` (samma data-dir som profiler).
- Max 50 entries (trim vid varje skrivning).
- Format: `{ entries: RestartEntry[] }` (nyaste sist).

## API-exponering
`GET /api/status` → `restarts: RestartEntry[]` (senaste 20, nyaste sist) i `pi/src/configServer.ts`.

## UI (`src/components/RestartHistoryPanel.tsx`)
- Egen `<details>`-sektion under StartAllPanel, alltid synlig (inte gömd bakom `!startAllOk`).
- Polling 10s.
- Visar: ikon per reason (RefreshCw/Bug/Skull/HelpCircle), tidsstämpel relativt + absolut, uptime, RSS, detail (truncated).
- Snabb-stat i summary: totalt antal, antal senaste 24h, mest förekommande reason.

## Tunings-historia
- `CONSECUTIVE_FAIL_LIMIT` höjt från 2 → 4 (2026-04-26) för att ge mer marginal innan vi nukar processen — auto-reconnect-loopen täcker normala disconnects, så denna path triggas mest vid initial-connect-misslyckanden.
