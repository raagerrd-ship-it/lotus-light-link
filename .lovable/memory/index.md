# Memory: index.md
Updated: 2026-08-29

## Project Memory

## Core
Headless Pi engine + PiMobile UI. No Web Audio/BLE in browser. Redirect to /pi-mobile.
Audio capture requires OS routing. Uses native alsa-capture binding.
Dirigent v2: brightness-formen drivs av analyser.intensity; rå amplitud är bara långsam loudness-skala.
Gain = EN linjär tvåpunkts-kurva mot Sonos-volym. Ingen dold RAW_SCALE, ingen mic-soft-clip, inget manuellt gain-läge.
Engine decoupled from UI. API URLs use port + 50.
Pi Control Center (PCC) aligned. Pi Zero 2W requires 512MB swap.
Lifecycle drivs av Sonos playbackState (ignite() vid boot). Manuell UI-disconnect sätter override som blockerar auto-start.
BLEDOM HCI-stuck recovery is process.exit via systemd. Never add same-process retry.
Short input-EMA (`lightSmoothMs` ~35 ms) before dB-mapping denoises base level without slowing beat attack.
Mic-start får aldrig gatas av BLE; starta mic-tasken före BLE-initiering och await:a den vid tidiga BLE-returer.

## Memories
- [Input-sync (form)](mem://pi/lighting/input-sync-form) — formen = bands.totalRms; intensity BARA topp-boost >90%; ingen loudness-faktor; beatLeadMs 0
- [Lärd volym→gain](mem://pi/audio/learned-volume-gain) — per-volym aggregat (4s-p90 medel) → LÅS efter 20 min → persisterat; relearnGain för omlärning
- [Adaptivt tak + pre-drop](mem://pi/lighting/adaptive-ceiling-and-buildup) — inLow/inHigh från långsam EMA (~7s) per låt + buildUpGain-svällning; bryggeri-defaults
- [BLE supervision timeout + ljus-frys-larm](mem://pi/ble/supervision-timeout-and-down-alarm) — 5 s supervision timeout i initial och re-assert-lecup; downForMs + engångslarm efter 15 s under MOTOR_ON
- [Mic-start gating](mem://pi/runtime/mic-start-never-gated-by-ble) — starta mic oberoende av BLE; await:a mic-tasken vid tidig BLE-fail
- [Statisk dynamik-expansion](mem://pi/lighting/static-dynamic-expansion) — level sträcks inLowFrac/inHighFrac × point1.gain → 0..1 ^ shapeExpand; floor 10, barAccent 1.8
- [Två tappar: AGC vs ljus](mem://pi/audio/two-taps-agc-vs-light) — o-gainad ring; AGC (mål 0.8) bara till analysen, egen linjär RMS × micGain till ljuset
- [Analysator-synk](mem://pi/audio/analyser-sync) — mirror av DMX Control (commit a5ccabe0): tempogram-BPM, kickAtMs, barShift, Lotus-adapter
- [Portable BLE driver](mem://pi/ble/portable-driver-layering) — pi/src/ble-driver/ fristående (noll outside-imports); ble/ är app-glue shims + subsystem-state; motor via createLampDriver
