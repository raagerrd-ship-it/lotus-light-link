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
- [Halvöppen ACL-rivning](mem://pi/ble/half-open-acl-drop-request) — ble-drop.req vid varje connect-failure; path-aktiverad root-service river länken
- [Input-sync (form)](mem://pi/lighting/input-sync-form) — formen = bands.totalRms; intensity BARA topp-boost >90%; ingen loudness-faktor; beatLeadMs 0
- [Lärd volym→gain](mem://pi/audio/learned-volume-gain) — per-volym aggregat (4s-p90 medel) → LÅS efter 20 min → persisterat; relearnGain för omlärning
- [Adaptivt tak + pre-drop](mem://pi/lighting/adaptive-ceiling-and-buildup) — inLow/inHigh från långsam EMA (~7s) per låt + buildUpGain-svällning; bryggeri-defaults
- [BLE supervision timeout + ljus-frys-larm](mem://pi/ble/supervision-timeout-and-down-alarm) — 5 s supervision timeout i initial och re-assert-lecup; downForMs + engångslarm efter 15 s under MOTOR_ON
- [Mic-start gating](mem://pi/runtime/mic-start-never-gated-by-ble) — starta mic oberoende av BLE; await:a mic-tasken vid tidig BLE-fail
- [Mic-återställning (steg)](mem://pi/audio/mic-recovery-ladder) — I2S unbind/bind via lotus-i2s-rebind + process MÅSTE dö; 2 rebind → 2 reboot → idle-färg
- [Statisk dynamik-expansion](mem://pi/lighting/static-dynamic-expansion) — level sträcks inLowFrac/inHighFrac × point1.gain → 0..1 ^ shapeExpand; floor 10, barAccent 1.8
- [Två tappar: AGC vs ljus](mem://pi/audio/two-taps-agc-vs-light) — o-gainad ring; AGC (mål 0.8) bara till analysen, egen linjär RMS × micGain till ljuset
- [En linjär gain](mem://pi/audio/single-linear-gain) — RAW_SCALE=5 borta; tvåpunkts Sonos-kurva enda gain-källan (5–300×)
- [Analysator-synk](mem://pi/audio/analyser-sync) — mirror av DMX Control (commit a5ccabe0): tempogram-BPM, kickAtMs, barShift, Lotus-adapter
- [TV-läge & profil-globaler](mem://pi/runtime/tv-mode-profiles) — TV idlar ej motorn, auto-gain-override, dimmingGamma/gainCalibration per profil, /api/tv-profile
- [Taktklocka + grid-puls](mem://pi/audio/beat-clock-grid-pulse) — beatClock.ts, PLL mot kicks, puls med beatLeadMs försprång
- [Dirigent v2](mem://pi/lighting/dirigent-v2-intensity-brightness) — brightness = intensity-form × långsam loudness; levelVU driver aldrig ljus-formen
- [Portable BLE driver](mem://pi/ble/portable-driver-layering) — pi/src/ble-driver/ fristående (noll outside-imports); ble/ är app-glue shims + subsystem-state; motor via createLampDriver
- [Attack/release smoothing](mem://pi/lighting/attack-release-smoothing) — log-release vs mjuk-attack (lowSoftFloor), golv som dynamisk lyft, inverterat flicker-deadband, soft-watchdog
- [Hardware limitations](mem://constraints/hardware-limitations) — BLEDOM forces color change on mic mode, use mobile mic
- [Database persistence](mem://technical/database-persistence) — Offline-first sync logic to Supabase
- [Sonos metadata](mem://technical/sonos-metadata-resolution) — CORS and deep extraction of album art
- [Frequency blending](mem://technical/audio-processing/frequency-blending) — 150Hz split and bass weight logic
- [Punch white](mem://features/lighting/punch-white) — Threshold effect for maximum intensity flashes
- [Symmetric dynamics](mem://technical/dynamics-processing/symmetric-dynamics) — Fixed dynamicCenter=0.5 by default (centerAdaptSeconds=999); adaptive mode optional via config
- [Fast dynamic center](mem://pi/lighting/fixed-dynamic-center) — centerAdaptSeconds default 999 prevents sustained energy from being normalized back to a running average
- [Device modes](mem://features/lighting/device-modes) — RGB vs Brightness-only packet configurations
- [Google login](mem://auth/google-login-branding) — Custom OAuth redirect URI for branding
- [Sonos capture constraint](mem://constraints/sonos-audio-capture-limitations) — Sonos capture requires OS routing
- [TV source handling](mem://technical/sonos/tv-source-handling) — Treat TV/SPDIF as PAUSED to force idle mode
- [Pi pinouts](mem://technical/hardware/pi-pin-configuration) — GPIO configurations for INMP441, MAX31865, HW-281
- [Deployment workflow](mem://technical/maintenance/pi-deployment-workflow) — Phase 1 (Cast Away) vs Phase 2 (Brew Monitor)
- [Relay logic](mem://technical/hardware/pi2-relay-logic) — HW-281 optocoupler active low configuration
- [Client sync](mem://technical/sonos/client-sync-strategy) — 2s status poll, track pos delta inference
- [Pi2 control system](mem://features/fermentation/pi2-control-system) — Dedicated fermentation controller with RAPT Pill
- [Hardware settings](mem://pi/hardware-settings) — INMP441 micGainBase, Hann window, hi-shelf EQ
- [Tick rate normalization](mem://technical/engine/tick-rate-normalization) — Physics calculated relative to 125ms
- [BLE protocol](mem://pi/ble/protocol-and-management) — BLEDOM 9-byte packet and backoff strategy
- [Sonos gateway integration](mem://pi/sonos/gateway-integration) — Auto-detect Cast Away core on ports 3050-3052
- [Noble compatibility](mem://pi/runtime/noble-compatibility) — Check state and _state on noble object
- [Build resources](mem://pi/deployment/build-and-resources) — RAM/swap requirements for building on Pi Zero 2W
- [BLE keep-alive](mem://pi/ble/keep-alive) — 1s keep-alive packet to prevent BLEDOM timeout
- [PCC alignment](mem://pi/runtime/pcc-alignment) — Pi Control Center integration and runInstallOnRelease
- [BLE permissions](mem://pi/ble/permissions-model) — AmbientCapabilities and NoNewPrivileges configuration
- [BLE library rationale](mem://pi/ble/library-choice-rationale) — Noble chosen over D-Bus for HCI config
- [Hybrid discovery](mem://pi/ble/hybrid-discovery-strategy) — hcitool för lescan, noble för GATT
- [BLE anti-churn](mem://pi/ble/anti-churn-connect-cooldown) — 4s cross-restart cooldown, 2s golv, churn-guard, bounded shutdown-disconnect
- [BLE fast-fail restart](mem://pi/ble/fast-fail-self-restart) — Process restart after 4 consecutive failures; same-process retry banned
- [Heap-tak & swappiness](mem://pi/runtime/heap-cap-and-swappiness) — heap 96MB + vm.swappiness=10 mot watchdog-frysningar vid RSS ~110MB
- [Runtime-hälsa](mem://pi/runtime/health-telemetry) — /api/status.runtime: fftFps, loopLag, tickJitter + OS-checklista
- [Ingen lokal Sonos-gateway](mem://pi/sonos/no-local-gateway) — gateway på brew-Pi:n; inga 127.0.0.1-fallbackar, explicit adress + degraded efter 30 s
- [Sonos-driven lifecycle](mem://pi/runtime/sonos-driven-lifecycle) — ignite() + state-machine, ersätter /tmp-flagga som restart-driver
- [Input-gain vs ljus-skala](mem://pi/lighting/two-stage-gain-vs-lightscale) — lightScale 0.8 ger drop-headroom; NIVÅ-baren visar BLE brightness
- [Frame-takt 75 Hz](mem://pi/audio/frame-ms-75hz) — FRAME_MS 13.33 ms är sann takt; fftMs=10 kvar medvetet (gehörs-trim)
- [ARM64 build pipeline](mem://pi/deployment/arm64-build-pipeline) — Node 24 ARM64 actions and PCC static deploy
- [Gamma correction](mem://technical/lighting/gamma-correction) — Gamma 1.8 applied to physical brightness
- [Signal processing chain](mem://pi/audio/signal-processing-chain) — Pipeline order from Mic to Gamma
- [FFT resolution](mem://technical/audio-processing/fft-resolution) — 1024 samples, 128 hop-size
- [Onset energy gate](mem://pi/audio/onset-energy-gate) — onsetEnergyFloor gates processOnset by totalRms (no flashes in silence)
- [Sonos subscribe-race fix](mem://pi/sonos/subscribe-race-fix) — async fetchStatusOnce + position heartbeat var ~10s
- [Softness slider](mem://pi/ui/softness-slider-curve) — Exponential mapping for releaseAlpha
- [Percentil-AGC](mem://pi/audio/percentile-agc) — analysator-AGC mot 95:e percentilen (mål 0.75 tak, maxGain 200) + persisterade ljus-defaults
- [Native capture](mem://pi/audio/native-capture) — C++ alsa-capture binding with Int16Array
- [Tick-frysning](mem://pi/runtime/tick-freeze-recovery) — native-call-instrumentering, mic-stall-restart, per-delsystem watchdog-recovery
- [Hop/tick-låsning](mem://pi/audio/hop-size-decoupled) — HOP=600 (80Hz FFT) låst 2:1 mot tickMs=25; ändra båda ihop
- [No blocking syscalls](mem://pi/runtime/no-blocking-syscalls-on-request-path) — Blocking system calls stay off request paths
- [No timer on FFT tick](mem://pi/runtime/no-settimeout-on-fft-tick-path) — Keep setTimeout out of FFT tick path
- [Silent logging](mem://pi/runtime/silent-by-default-logging) — Debug logging is opt-in
- [Native ALSA install](mem://pi/audio/native-alsa-capture-install) — Native addon must rebuild on Pi with ALSA headers
- [Native only capture](mem://pi/audio/native-only-no-arecord-fallback) — No arecord fallback in engine
- [ALSA buffer sizing](mem://pi/audio/alsa-buffer-sizing) — 16× period buffer and explicit period count are required on current Pi evidence
- [I2S initial DC wedge](mem://pi/audio/i2s-initial-dc-wedge) — No more ALSA hypothesis patches before strace ioctl diff from process start
