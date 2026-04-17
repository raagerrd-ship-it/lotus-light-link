---
name: HCI release policy
description: När noble släpper HCI-socketen vs håller den — forget device, shutdown och HCI-scan släpper, normal disconnect under demand håller
type: feature
---

Noble äger HCI-socketen genom hela drift-livscykeln. Att släppa den
(`hciconfig hci0 reset`) tvingar noble till `unknown`-state och kräver
`forceNoblePoweredOn` (5–16s) före nästa connect, så vi gör det bara där det
verkligen behövs.

**Släpper HCI:**
- `forgetDevice()` — användaren har glömt enheten, ingen reconnect ska ske
- `disconnect(releaseHci=true)` — explicit kallad från shutdown
- SIGTERM/SIGINT-shutdown — adaptern ska vara helt ren när PCC startar om
- `/api/ble/hci-scan` — efter scan så noble kan ta över utan kollision
- `disconnect()` när `isDemandActive()` är false — default-beteende

**Behåller HCI (noble äger socketen):**
- `disconnect(releaseHci=false)` när demand är true — reconnect ska kunna fyra direkt
- Normal `peripheral.disconnect`-event under drift — keep-alive + reconnect-loop tar hand om det
- Connect-fel — `forceNoblePoweredOn` återhämtar bara om noble *inte* redan är poweredOn
