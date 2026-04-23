---
name: hcitool lecup måste köras post-connect
description: Noble's interna HCI-request för 7.5ms connection interval slår inte alltid igenom. Vi kör `hcitool lecup --min 6 --max 6 --latency 0 --timeout 100` 500ms efter GATT-connect som fallback. Bevisat 2026-04-23 — utan detta default:ar lampan till ~50ms (=20pps tak).
type: feature
---
**Problem:** noble's `connection-optimization`-väg (mem://pi/ble/connection-optimization) kör HCI LE Connection Update Request, men den slår inte alltid igenom. Lampan kör då default ~50ms interval → ~20 pps radiotak. Vid `tickMs=25ms` (40 pps) köar paketen i noble:s `_aclQueue` och ljuset halkar efter musiken.

**Bevisat 2026-04-23:**
1. Bench körde med `tickMs=50→20ms`. Vid 50ms kö-peak 34 paket (= radio-tak ~20pps).
2. Manuellt på Pi:n: `sudo hcitool lecup --handle 64 --min 6 --max 6 --latency 0 --timeout 100`
3. Bench igen → alla steg PASS (20-50 pps), avgLat <1ms, queuedPk=0 hela vägen.

**Fix:** `pi/src/ble/forceConnInterval.ts` spawnar `hcitool lecup` 500ms efter `attachControllerDrain()` i `connect-hardcoded.ts`. Failure är non-fatal (hcitool saknas / controller säger nej / handle ogiltig → loggas, fortsätter). Bench-UI:t visar `connInterval` så vi ser om fallbacken slog igenom.

**Krav:**
- `hcitool` måste finnas i PATH (`bluez` paket på Raspberry Pi OS).
- Service måste ha `CAP_NET_RAW` + `CAP_NET_ADMIN` (redan satt via AmbientCapabilities, se mem://pi/ble/permissions-model).
- Handle hämtas via `getAttachedHandle()` från `controllerDrain.ts`.

**Verifiera efter deploy:**
- `systemctl --user status lotus-light-engine -l --no-pager` ska visa rad `[forceConnInterval] OK handle=N → 7.5ms target`
- Bench-UI ska visa `connInterval: 7.5ms` (grön) istället för `50ms` (röd) eller `okänt`.
