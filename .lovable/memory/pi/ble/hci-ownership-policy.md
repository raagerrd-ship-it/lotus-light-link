---
name: HCI ownership — noble owns the socket
description: Noble äger HCI-socketen från boot till SIGTERM. Inga auto-release i forget/disconnect/scan. Manuell reset endast via /api/ble/reset.
type: feature
---
Noble håller HCI-socketen genom hela processens livscykel — från `npm start` till SIGTERM.

**Inga auto-release i normalflödet:**
- `forgetDevice()` — disconnectar peripheral men släpper INTE HCI
- `disconnect()` — default `releaseHci=false`; behåller noble live
- Scan-retry — anropar bara `resetHciAdapter` om effektiv adapter-state ≠ poweredOn
- Direct-connect-fail — samma villkorade reset
- Boot — `ensureAdapterUp()` (rfkill unblock + hciconfig up), INGEN reset

**Manuell recovery:**
- `POST /api/ble/reset` — anropar `disconnect(true)` → full HCI-release
- UI-knapp "Återställ BLE-stack" i diagnostikpanelen (bekräfta först)
- Endast för debugging när noble verkligen fastnat i `unknown`

**Varför:** På Raspberry Pi wedgar destruktiva `hciconfig down/up/reset` raw `noble.state` i `unknown` även när kerneladaptern är frisk (`UP RUNNING`, caps OK, rfkill not blocked). Genom att aldrig röra adaptern under live-noble undviker vi den här race condition helt.

**Effektiv adapter-state vs raw noble.state:**
- `getAdapterState()` returnerar `poweredOn` om `processHasBtCaps()` även när raw är `unknown`
- UI visar båda — raw är förväntat unknown på Pi och visas dimmat med förklaring
