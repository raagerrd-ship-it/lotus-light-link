---
name: BLE_BUILD_TAG bump policy
description: Bumpa BLE_BUILD_TAG i pi/src/ble/state.ts vid varje BLE-ändring så UI/diagnostik visar exakt release Pi:n kör.
type: preference
---
**Regel:** Vid varje ändring i `pi/src/ble/**` MÅSTE `BLE_BUILD_TAG` i `pi/src/ble/state.ts` bumpas.

**Format:** `YYYY-MM-DD/kort-slug` — t.ex. `2026-04-17/noble-safe-reinit`. Slug ska beskriva ändringen kort (kebab-case).

**Varför:** Tagg syns i boot-log, `/api/ble/diagnostics` och PiMobile UI. Utan bump går det inte att verifiera om Pi:n faktiskt kör senaste releasen efter deploy via GitHub Actions.

**How to apply:**
- Ändrar du noble-init, scan, connect, reconnect, protocol, adapter, save, state → bumpa.
- Ändrar du bara kommentarer/typer utan beteendeförändring → behöver inte bumpa.
- Flera BLE-ändringar i samma loop = en gemensam bump räcker.
