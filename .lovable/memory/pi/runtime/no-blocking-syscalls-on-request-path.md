---
name: Inga blockerande syscalls i request-pathen
description: configServer-endpoints (särskilt /api/status som pollas var 5:e sek av UI:t) får ALDRIG anropa execSync, busy-loops eller annat som blockerar libuv. Det får noble att missa stateChange-event och hela API:t att verka "hänga".
type: constraint
---
`/api/status` pollas av UI:t var ~5:e sekund. Tidigare anropades `refreshVersionInfo()` på varje request, vilken vid avsaknad av VERSION.json föll tillbaka på 3× `execSync('git ...', { timeout: 3000 })` = upp till 9 sekunders synkron blockering per request.

Konsekvens: libuv-event-loopen blockerades konstant → noble's interna `stateChange`-event missades → BLE fastnade i `unknown` → UI:t fick `signal timed out` på alla `/api/status`-anrop → backend "hängde sig" även när inget BLE-anrop var igång.

**Regler:**
1. INGEN `execSync` i request-handlers. Använd boot-tids-läsning + cache.
2. Cache version-info med TTL (≥60s) och uppdatera bara från VERSION.json — git-fallback körs en gång vid start, aldrig på request-pathen.
3. `console.warn` i loop = också blockerande på Pi Zero 2W. Logga bara en gång.

Se `pi/src/configServer.ts` `refreshVersionInfo()` + `readVersionFileOnce()`.

Build tag: `2026-04-19/no-execsync-on-status-path`
