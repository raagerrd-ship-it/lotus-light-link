---
name: BLEDOM max write rate
description: BLEDOM på Pi kraschar länken (reason=8) vid >15 writes/s. sendToBLE har hard cap MIN_WRITE_INTERVAL_MS=66ms.
type: constraint
---
BLEDOM-lampor på Pi (utan möjlighet att sänka HCI connection interval — "HCI access limited") tappar BLE-länken med reason=8 supervision timeout om writes skickas snabbare än ~15/s.

**Regel:** `sendToBLE()` i `pi/src/ble/protocol.ts` har en hard rate-limit `MIN_WRITE_INTERVAL_MS = 66` (≥66ms mellan writes = max ~15/s). Sänk inte under detta utan att verifiera mot reason=8.

Engine kan tickka snabbare (40 Hz) men BLE-laget throttlar — överskott räknas i `bleStats.skipBusyCount`.

Build tag: `2026-04-19/ble-write-rate-limit-15hz`
