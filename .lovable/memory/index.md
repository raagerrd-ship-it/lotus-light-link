# Project Memory

## Core
Headless Pi engine + PiMobile UI. No Web Audio/BLE in browser. Redirect to /pi-mobile.
Audio capture requires OS routing. Uses native alsa-capture binding.
Offline-first: localStorage syncs to Supabase user_settings on login.
Engine decoupled from UI. API URLs use port + 50.
Pi Control Center (PCC) aligned. Pi Zero 2W requires 512MB swap.
Lifecycle drivs av Sonos playbackState (ignite() vid boot). Manuell UI-disconnect sätter override som blockerar auto-start.
BLEDOM HCI-stuck recovery is process.exit via systemd. Never add same-process retry.

## Memories
- [Portable BLE driver](mem://pi/ble/portable-driver-layering) — pi/src/ble-driver/ fristående (noll outside-imports); ble/ är app-glue shims + subsystem-state; motor via createLampDriver
- [Attack/release smoothing](mem://pi/lighting/attack-release-smoothing) — log-release vs mjuk-attack (lowSoftFloor), golv som dynamisk lyft, inverterat flicker-deadband, soft-watchdog
- [Hardware limitations](mem://constraints/hardware-limitations) — BLEDOM forces color change on mic mode, use mobile mic
- [Database persistence](mem://technical/database-persistence) — Offline-first sync logic to Supabase
- [Sonos metadata](mem://technical/sonos-metadata-resolution) — CORS and deep extraction of album art
- [Frequency blending](mem://technical/audio-processing/frequency-blending) — 150Hz split and bass weight logic
- [Punch white](mem://features/lighting/punch-white) — Threshold effect for maximum intensity flashes
- [Symmetric dynamics](mem://technical/dynamics-processing/symmetric-dynamics) — Adaptive dynamicCenter tracking with symmetric expansion
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
- [BLE protocol](mem://technical/ble/protocol-and-management) — BLEDOM 9-byte packet and backoff strategy
- [System design](mem://technical/architecture/system-design) — Framework-agnostic engine decoupled from React
- [Gateway integration](mem://pi/sonos/gateway-integration) — Auto-detect Cast Away core on ports 3050-3052
- [Noble compatibility](mem://pi/runtime/noble-compatibility) — Check state and _state on noble object
- [Build resources](mem://pi/deployment/build-and-resources) — RAM/swap requirements for building on Pi Zero 2W
- [BLE keep-alive](mem://pi/ble/keep-alive) — 1s keep-alive packet to prevent BLEDOM timeout
- [BLE fast-fail restart](mem://pi/ble/fast-fail-self-restart) — Process restart after 4 consecutive failures; same-process retry banned
- [Pi exclusive focus](mem://architecture/pi-exclusive-focus) — Architecture focused on headless Pi engine
- [Event-driven engine](mem://pi/performance/event-driven-architecture) — Engine execution triggered by FFT frames
- [BLE optimization](mem://pi/ble/connection-optimization) — 7.5-10ms connection interval via HCI
- [API routing](mem://pi/ui/api-routing) — API URLs generated as window.location.port + 50
- [ARM64 build pipeline](mem://pi/deployment/arm64-build-pipeline) — Node 24 ARM64 actions and PCC static deploy
- [Gamma correction](mem://technical/lighting/gamma-correction) — Gamma 1.8 applied to physical brightness
- [Signal processing chain](mem://pi/audio/signal-processing-chain) — Pipeline order from Mic to Gamma
- [FFT resolution](mem://technical/audio-processing/fft-resolution) — 1024 samples, 128 hop-size
- [Onset energy gate](mem://pi/audio/onset-energy-gate) — onsetEnergyFloor gates processOnset by totalRms (no flashes in silence)
- [Sonos subscribe-race fix](mem://pi/sonos/subscribe-race-fix) — async fetchStatusOnce + position heartbeat var ~10s
- [Softness slider](mem://pi/ui/softness-slider-curve) — Exponential mapping for releaseAlpha
- [Native capture](mem://pi/audio/native-capture) — C++ alsa-capture binding with Int16Array
- [PCC alignment](mem://pi/runtime/pcc-alignment) — Pi Control Center integration and runInstallOnRelease
- [BLE permissions](mem://pi/ble/permissions-model) — AmbientCapabilities and NoNewPrivileges configuration
- [BLE library rationale](mem://pi/ble/library-choice-rationale) — Noble chosen over D-Bus for HCI config
- [Hybrid discovery](mem://pi/ble/hybrid-discovery-strategy) — hcitool for lescan, noble for GATT
- [Sonos-driven lifecycle](mem://pi/runtime/sonos-driven-lifecycle) — ignite() + state-machine, ersätter /tmp-flagga som restart-driver
