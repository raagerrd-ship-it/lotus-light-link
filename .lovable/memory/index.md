# Memory: index.md
Updated: today

# Project Memory

## Core
Headless Pi engine + PiMobile UI. No Web Audio/BLE in browser. Redirect to /pi-mobile.
Audio capture requires OS routing. Uses native alsa-capture binding.
Offline-first: localStorage syncs to Supabase user_settings on login.
Engine decoupled from UI. API URLs use port + 50.
Pi Control Center (PCC) aligned. Pi Zero 2W requires 512MB swap.
journalctl fungerar INTE på Pi:n — använd curl /api/ble/diagnostics, UI eventlog, eller manuell node-körning.
BLE writes always go through noble.characteristic.writeAsync(buf, true) — gatttool fallback removed (too slow + WriteWithoutResponse not exposed via CLI).

## Memories
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
- [HCI up-only policy](mem://pi/ble/hci-up-only-policy) — Engine får ALDRIG ta ner hci0 (no down/reset/hci.stop)
- [Pi exclusive focus](mem://architecture/pi-exclusive-focus) — Architecture focused on headless Pi engine
- [Event-driven engine](mem://pi/performance/event-driven-architecture) — Engine execution triggered by FFT frames
- [BLE optimization](mem://pi/ble/connection-optimization) — 7.5-10ms connection interval via HCI
- [API routing](mem://pi/ui/api-routing) — API URLs generated as window.location.port + 50
- [Pi port allocation](mem://pi/runtime/port-allocation) — Lotus engine API på 3050 (en port, alla rutter), UI på 3000. Ingen 3051.
- [journalctl saknas](mem://pi/runtime/journalctl-not-available) — journalctl --user fungerar inte; använd curl /api/ble/diagnostics istället
- [ARM64 build pipeline](mem://pi/deployment/arm64-build-pipeline) — Node 24 ARM64 actions and PCC static deploy
- [Gamma correction](mem://technical/lighting/gamma-correction) — Gamma 1.8 applied to physical brightness
- [Signal processing chain](mem://pi/audio/signal-processing-chain) — Pipeline order from Mic to Gamma
- [FFT resolution](mem://technical/audio-processing/fft-resolution) — 1024 samples, 128 hop-size
- [Palette integration](mem://pi/sonos/palette-integration) — 4-color palettes consumed directly from Sonos Gateway
- [Softness slider](mem://pi/ui/softness-slider-curve) — Exponential mapping for releaseAlpha
- [Lazy noble singleton](mem://pi/ble/lazy-noble-singleton) — Noble får aldrig require:as top-level; lazy via singleton/Proxy så event-loopen är ren när stateChange fyrar
- [No blocking syscalls](mem://pi/runtime/no-blocking-syscalls-on-request-path) — Inga execSync i /api/status — blockerar libuv & noble stateChange
- [BLE manual-only](mem://pi/ble/manual-only-connection-policy) — Anslutning sker ENDAST via Anslut-knapp; ingen auto-connect/reconnect
- [Native capture](mem://pi/audio/native-capture) — C++ alsa-capture binding with Int16Array
- [PCC alignment](mem://pi/runtime/pcc-alignment) — Pi Control Center integration and runInstallOnRelease
- [BLE permissions](mem://pi/ble/permissions-model) — AmbientCapabilities and NoNewPrivileges configuration
- [BLE library rationale](mem://pi/ble/library-choice-rationale) — Noble chosen over D-Bus for HCI config
- [Hybrid discovery](mem://pi/ble/hybrid-discovery-strategy) — Noble scan + connect, GATT handle caching
- [rfkill needs netdev group](mem://pi/ble/rfkill-needs-netdev-group) — /dev/rfkill kräver gruppmedlemskap, inte bara CAP_NET_ADMIN på binären
- [fix-sudo ownership](mem://pi/deployment/fix-sudo-ownership) — fix-sudo.sh ägs av PCC; Lotus har bara thin wrapper
- [HCI ownership policy](mem://pi/ble/hci-ownership-policy) — Noble äger HCI hela processen; ingen auto-release; manuell reset via /api/ble/reset
- [BLE build tag bump](mem://pi/ble/build-tag-policy) — Bumpa BLE_BUILD_TAG vid varje BLE-ändring
- [bluetoothd required](mem://pi/ble/bluetoothd-required) — Utan BlueZ daemon stannar noble.state på "unknown" för evigt
- [Node setcap krav](mem://pi/ble/node-setcap-required) — node-binären behöver setcap CAP_NET_RAW för noble; AmbientCapabilities räcker inte
- [BLE workaround counters](mem://pi/ble/workaround-counters) — Mät defensiva fallbacks i /api/ble/diagnostics
- [Connect flow hybrid](mem://pi/ble/connect-flow-hybrid) — autoConnectSaved måste ha direct + scan-fallback, L2CAP 8s
- [Noble stateChange race](mem://pi/ble/noble-statechange-event-loop-race) — Native modules (alsaMic) får INTE laddas före waitForFirstStateChange — blockerar libuv och äter noble's stateChange
- [Never force-mutate noble.state](mem://pi/ble/never-force-mutate-noble-state) — Vänta alltid på riktig stateChange via waitForPoweredOnAsync(10000); _state-mutation är no-op
- [Early listener miss](mem://pi/ble/early-listener-may-miss-statechange) — recordObservedNobleState från fallback-vägar när early-listener missar event
- [Inget bash -lc för system-CLI](mem://pi/ble/no-bash-lc-for-system-tools) — bash -lc i systemd user-service har tom PATH → hciconfig hittas inte; använd execSync direkt
- [Noble mgmt-socket release](mem://pi/ble/noble-mgmt-socket-release) — Släpp noble's mgmt/HCI vid boot utan sparad enhet och i forgetDevice så btmgmt find inte får "Busy"
- [Boot-time noble respawn](mem://pi/ble/boot-time-noble-respawn) — Triggar respawn om noble inte når poweredOn inom 5s vid boot (libuv-race)
- [Separera raw/eff/stateChange](mem://pi/ble/separate-raw-eff-statechange) — Tre oberoende BLE-statusbegrepp; blanda inte ihop dem i loggar/UI; scan fortsätter på effektiv readiness utan auto-respawn
