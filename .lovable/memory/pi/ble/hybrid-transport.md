---
name: Hybrid BLE transport (gatttool fallback)
description: When noble.state stays 'unknown', user can toggle a hcitool/gatttool transport that bypasses noble entirely for connect+writes
type: feature
---

There is a manual fallback BLE transport in `pi/src/ble/hciTransport.ts` that uses
a long-lived `gatttool -b MAC -I -t public` interactive session. It discovers the
BLEDOM `0xfff3` characteristic handle from `characteristics` output (defaults to
`0x0009` if parse fails) and sends 9-byte BLEDOM packets via `char-write-cmd`.

Activation:
- Persisted toggle in localStorage key `ble-hci-transport-enabled`
- API: `GET/PUT /api/ble/transport { hciEnabled }`
- UI: toggle in BLE diagnostics panel

When enabled:
- `nobleConnect` and `autoConnectSaved` route through `connectViaHciTransport`
- `sendToBLE` and `sendRawColor` route writes through `writeViaHciTransport`
- noble code paths are bypassed; no proactive reconnect from write failures

Use only when `noble.state` stays `unknown` despite `hciconfig hci0` showing UP.