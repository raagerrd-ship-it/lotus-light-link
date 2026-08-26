---
name: Anti-churn kring BLE connect/disconnect (FIX 5)
description: BLEDOM-firmware hänger vid connect-churn. Cooldown 4s cross-restart via /tmp/lotus-ble-connect-at, 2s golv i process, churn-guard 15s, bounded disconnect vid shutdown.
type: feature
---
Billiga ELK-BLEDOM-lampor hänger sin BLE-firmware vid snabb connect/disconnect-churn (5–10 cykler på ~1h, t.ex. en deploy-svit) — lampan slutar annonsera och kräver ström-cykel. Skydden (v1.0.774):

- **H1 bounded disconnect** (`pi/src/index.ts` shutdown): `Promise.race([disconnectHardcoded(), 1500ms])` — ren disconnect om möjligt, annars ge upp så processen alltid hinner ut före SIGKILL. Lägg ALDRIG tillbaka ett obounded await här.
- **H2 cross-restart cooldown**: `pi/src/ble-driver/connect-throttle.ts` skriver connect-ATTEMPT-tidsstämplar (ring, max 8) till `/tmp/lotus-ble-connect-at` (tmpfs → ingen SD-slitage, nollas vid reboot vilket är rätt). `toMotorOn()` awaitar `waitForConnectCooldown()` (4000 ms) före initial connect. Normal omstart = gammal tidsstämpel = ingen fördröjning.
- **H3 hårt golv 2000 ms** mellan connect-försök i samma process (`MIN_CONNECT_GAP_MS` i `connect.ts`), oavsett väg (HTTP/lifecycle/auto-reconnect).
- **H4 churn-guard**: >5 försök inom 30 s → wait minst 15 s + `recordRestart('ble-churn-guard', …)` via `setChurnHook`.

Rör inte: 1-slot-write-kontraktet, ACL-drain-gaten, conn-interval-forcering, watchdogen. Detta är enbart tids-spärrar runt connect/disconnect.
