---
name: BLE connection interval — 20ms target
description: Vi tvingar fram min=max=16 (20ms) via hcitool lecup direkt efter GATT-connect. Var 7.5ms tidigare men sänkt 2026-04-25 efter 22h-hängning på Pi Zero 2W.
type: feature
---
**Värde:** `min=max=16` units = **20ms connection interval**. Latency=0, supervision timeout=1s.

**Var:** Defaults i `pi/src/ble/forceConnInterval.ts`. Kommandot körs ~500ms efter lyckad GATT-connect i `connect-hardcoded.ts`. Failure är icke-fatal.

**Varför 20ms (var 7.5ms):**
- Pi Zero 2W BCM43436 delar radio mellan WiFi + BT
- 7.5ms gav ~133 BLE-events/s + WiFi-trafik → konstant interrupt-tryck
- Pi:n hängde efter ~22h drift (misstänkt controller-buffer/IRQ-stress)
- 20ms ger ~50 events/s → halverad BT-load
- tickMs=20ms → exakt 1 BLE-slot per tick → single-slot-kontraktet bevaras
- Worst-case latens 20ms < flicker fusion threshold (~50ms) → osynligt

**Verifiering:** `BLE_BUILD_TAG` i `state.ts` = `2026-04-25/conninterval-20ms`. Logas vid boot och syns i `/api/status` JSON som `build.bleTag`. Bench-värde `connInterval` i UI ska visa 20ms efter connect.

**Om hängningen återkommer:** Höj till 30ms (min=max=24) eller lägg till memory-logging var 5:e min för att fånga läckage före nästa krasch.
