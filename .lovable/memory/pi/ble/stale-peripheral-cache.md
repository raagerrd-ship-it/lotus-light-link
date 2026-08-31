---
name: stale-peripheral-cache
description: Noble's interna _peripherals[id] måste purgas mellan reconnects mot samma MAC, annars hänger connectAsync tyst
type: feature
---
När BLEDOM-länken dör tyst (radio-timeout utan disconnect-event, typiskt vid Sonos pause + keep-alive-fail) sitter noble kvar med en peripheral i `_peripherals[id]` som internt tror att GATT-sessionen lever. Nästa `peripheral.connectAsync()` mot den instansen hänger oändligt.

**Fix:** `forceCleanupStalePeripheral()` i `pi/src/ble/connect-hardcoded.ts` körs:
1. Före varje `connectHardcoded()` (steg 0 i scan-then-connect)
2. När keep-alive failar `KEEPALIVE_FAIL_THRESHOLD` (5) gånger i rad

**Guarden i purge-loopen gatar på `p.state === 'connected'` och måste fyra ALLTID** — INTE `&& !_connected`. Vanligaste fallet: connect lyckas → `_connected` sätts → GATT misslyckas ("Disconnected 34") → `_connected` nollställdes aldrig. Numera nollställs `_connected` även i GATT-/anchor-write-felgrenarna. Stale-flaggan sätts till `'disconnected'` efter bounded (2 s) disconnect.

Den `delete noble._peripherals[key]` för alla cache-entries som matchar HARDCODED_DEVICE.mac, så scan skapar en fresh peripheral nästa gång MAC:en discoveras. Idempotent.
