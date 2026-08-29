---
name: Mic-start får aldrig gatas av BLE
description: I engineLifecycle.toMotorOn startas startMicSubsystem() FÖRE och oberoende av startBleEngineMinimal(); ready=false får inte returnera innan micen startats.
type: constraint
---
Tidigare bugg: `toMotorOn()` gjorde `await startBleEngineMinimal()` och `return` vid
`ready=false` — micen startades då aldrig (`audioCbs=0`), vilket såg ut som en mic-krasch
men var ren startordning. Symptom syns särskilt vid manuell körning utan systemd-rättigheter
(noble får inte upp adaptern).

Regel: mic-tasken skapas först, BLE-stacken efteråt. Tidiga returns måste `await` mic-tasken.
