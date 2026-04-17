---
name: Noble unknown-state recovery loop
description: When noble.state stays 'unknown' on Pi, forceNoblePoweredOn loops up to 5 times with hciconfig down/up/reset + restartNobleHci before giving up
type: feature
---

On Raspberry Pi, noble's HCI binding sometimes stays in `unknown` even when
`hciconfig hci0` shows UP RUNNING and the process has CAP_NET_RAW + CAP_NET_ADMIN.
This blocks `startScanningAsync` and all GATT operations.

`forceNoblePoweredOn` in `pi/src/ble/connect.ts` runs up to 5 attempts. Each:
1. `resetHciAdapter()` — full `hciconfig hci0 down/up/reset` to release the kernel HCI socket
2. `restartNobleHci()` — bounces noble's internal `_bindings._hci.start()`
3. `waitForPoweredOnAsync(2000)` — wait up to 2s for noble to confirm poweredOn

Aborts early on `unauthorized` / `poweredOff` (hard fails). Worst case ~16s.

Replaced the previous gatttool fallback which proved unfit for realtime writes
(BLEDOM only supports WriteWithoutResponse, which gatttool exposes only inside
its interactive mode — not via CLI flags — making it too slow + fragile for
8–30 writes/sec).
