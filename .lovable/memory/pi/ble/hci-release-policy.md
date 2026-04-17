---
name: HCI release policy
description: När noble släpper HCI-socketen vs håller den — forget device, shutdown och HCI-scan släpper, normal disconnect under demand håller, boot-time clean slate skyddar mot krasch
type: feature
---

Noble äger HCI-socketen genom hela drift-livscykeln. Att släppa den
(`hciconfig hci0 reset`) tvingar noble till `unknown`-state och kräver
`forceNoblePoweredOn` (5–16s) före nästa connect, så vi gör det bara där det
verkligen behövs.

**Boot-time clean slate (pi/src/index.ts main step 5):**
- Vid varje process-start körs `resetHciAdapter()` ovillkorligt
- Skyddar mot stale state efter strömavbrott, OOM-kill, kernel panic,
  git-uppdatering eller process som inte hann köra SIGTERM-shutdown
- Kärnan släpper HCI-socketen automatiskt vid process-död, men bluez kan
  ha kvar konstigt internal state — denna rens normaliserar adaptern
- Kostar ~1s vid boot, billigt jämfört med att fastna i `unknown` vid första connect

**Släpper HCI explicit:**
- `forgetDevice()` — användaren har glömt enheten, ingen reconnect ska ske
- `disconnect(releaseHci=true)` — explicit kallad från shutdown
- SIGTERM/SIGINT-shutdown — adaptern ska vara helt ren när PCC startar om
- `/api/ble/hci-scan` — efter scan så noble kan ta över utan kollision
- `disconnect()` när `isDemandActive()` är false — default-beteende

**Behåller HCI (noble äger socketen):**
- `disconnect(releaseHci=false)` när demand är true — reconnect ska kunna fyra direkt
- Normal `peripheral.disconnect`-event under drift — keep-alive + reconnect-loop tar hand om det
- Connect-fel — `forceNoblePoweredOn` återhämtar bara om noble *inte* redan är poweredOn

**Persisterad state (storage.ts):**
- Endast metadata sparas: ble-device-id, name, address, addressType, connectable, serviceUuids
- Ingen "is-connected"-flagga eller HCI-låsstate skrivs till disk
- Vid omstart finns alltså aldrig en filbaserad lock som blockerar reconnect
