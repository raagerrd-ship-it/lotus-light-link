# Memory: index.md
Updated: today

# Project Memory

## Core
Headless Pi engine + PiMobile UI. No Web Audio/BLE in browser. Redirect to /pi-mobile.
Audio capture requires OS routing. Native alsa-capture binding ONLY — no arecord fallback. Default device hw:0,0.
Offline-first: localStorage syncs to Supabase user_settings on login.
Engine decoupled from UI. API URLs use port + 50.
Pi Control Center (PCC) aligned. Pi Zero 2W requires 512MB swap.

## Memories
- [Native-only mic policy](mem://pi/audio/native-only-no-arecord-fallback) — arecord-fallback borttagen, engine fail-hard utan capture.node
- [Anti-fladder pipeline](mem://pi/audio/anti-flicker-pipeline) — slew-rate + perceptuell deadband + adaptiv onset-suppression mot mikrojitter på loud-passager
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
- [BLE keep-alive](mem://pi/ble/keep-alive) — 200ms keep-alive bär idle-färg + länk (owner-switch model)
- [Stale-write force](mem://pi/ble/stale-write-force) — Bypass delta-skip efter 400ms i active mode så tyst musik inte tappar BLEDOM-länken
- [Idle force on pause](mem://pi/ble/idle-force-on-pause) — sendIdleForce bypasses busy/rate-limit/delta so lamp lands on idle immediately at pause
- [Pi exclusive focus](mem://architecture/pi-exclusive-focus) — Architecture focused on headless Pi engine
- [Event-driven engine](mem://pi/performance/event-driven-architecture) — Engine execution triggered by FFT frames
- [BLE optimization](mem://pi/ble/connection-optimization) — 20ms connection interval (var 7.5ms, sänkt 22h-hängningsfix)
- [Update måste chown:a storage](mem://pi/deployment/update-must-chown-storage) — cp -r som root → root-ägda filer → /api/* save returnerar 500. Fix: chown -R efter varje update.
- [Service-user måste vara pi](mem://pi/deployment/service-user-must-be-pi) — Default `pi`, override via LOTUS_SERVICE_USER eller systemd User=. Aldrig root/SUDO_USER.
- [Manual update only](mem://pi/deployment/manual-update-only) — services.json: runInstallOnRelease:false, autoUpdate:false. Ingen auto-deploy från GitHub-releases.
- [Tyst loggning](mem://pi/runtime/silent-by-default-logging) — All console.log via dlog() bakom LOTUS_DEBUG=1. UI visar live-state via /api/status.live, inte via loggen.
- [Auto-restart vid crash](mem://pi/runtime/auto-restart-on-crash) — /tmp-flagga sätts vid lyckad BLE-connect. Systemd-restart (OOM, crash, BLE-fail) startar hela kedjan automatiskt.
- [API routing](mem://pi/ui/api-routing) — API URLs generated as window.location.port + 50
- [ARM64 build pipeline](mem://pi/deployment/arm64-build-pipeline) — Node 24 ARM64 actions and PCC static deploy
- [Gamma correction](mem://technical/lighting/gamma-correction) — Gamma 1.8 applied to physical brightness
- [Signal processing chain](mem://pi/audio/signal-processing-chain) — Pipeline order from Mic to Gamma
- [Single smoothing on tick](mem://pi/audio/single-smoothing-on-tick) — En EMA i tickInner @ 50Hz, alsaMic levererar rå RMS, default releaseAlpha=0.15
- [FFT anti-alias buffer](mem://pi/audio/fft-anti-alias-buffer) — 3-frame rolling average på bands-RMS i alsaMic (~30ms), eliminerar 50Hz×100Hz alias. flux passerar oförändrad.
- [FFT resolution](mem://technical/audio-processing/fft-resolution) — 1024 samples, 128 hop-size
- [HOP frikopplad](mem://pi/audio/hop-size-decoupled) — HOP=512 fast (~10.7ms), FFT 93Hz, engine gatear på tickMs
- [Inget setTimeout i FFT-tick](mem://pi/runtime/no-settimeout-on-fft-tick-path) — onFFTFrame får aldrig schemalägga setTimeout, då körs tickInner mot gammal frame
- [Single-slot BLE-write](mem://pi/ble/single-slot-write-contract) — En writeAsync åt gången, hard-fail vid busy, ingen rate-limit, keep-alive bara i idle
- [hcitool lecup post-connect](mem://pi/ble/force-conninterval-hcitool) — Tvinga 7.5ms connection interval via hcitool 500ms efter connect — noble's egen request slår inte alltid igenom
- [Stale peripheral cache](mem://pi/ble/stale-peripheral-cache) — Purga noble._peripherals[id] mellan reconnects mot samma MAC
- [Late connect-timeout race](mem://pi/ble/late-connect-timeout-race) — withTimeout(connectAsync) kan kasta efter lyckad connect → catch måste guardas med resolved-flagg
- [Auto-reconnect-loop](mem://pi/ble/auto-reconnect-loop) — Backoff 2→4→8→16→30s, aktiveras först efter lyckad connect, stoppas av manuell disconnect
- [Fast-fail self-restart](mem://pi/ble/fast-fail-self-restart) — BLEDOM ansluter på 1-2s eller aldrig: 2 failures → process.exit(0) + /tmp-flagga + auto-connect vid boot
- [Stability hardening](mem://pi/runtime/stability-hardening) — Auto-reconnect cap (20), debounce (1s), watchdog warn rate-limit (10s), listener guard, mic timer cleanup, Sonos SSE pausar poll
- [Palette integration](mem://pi/sonos/palette-integration) — 4-color palettes consumed directly from Sonos Gateway
- [Softness slider](mem://pi/ui/softness-slider-curve) — Exponential mapping for releaseAlpha
- [Native capture](mem://pi/audio/native-capture) — C++ alsa-capture binding with Int16Array
- [PCC alignment](mem://pi/runtime/pcc-alignment) — Pi Control Center integration and runInstallOnRelease
- [BLE permissions](mem://pi/ble/permissions-model) — AmbientCapabilities and NoNewPrivileges configuration
- [BLE library rationale](mem://pi/ble/library-choice-rationale) — Noble chosen over D-Bus for HCI config
- [Hybrid discovery](mem://pi/ble/hybrid-discovery-strategy) — hcitool för lescan, noble för GATT
- [Onset-tuning](mem://pi/audio/onset-tuning) — Slidrar för beat-känslighet och beat-mellanrum, runtime-tunbar via cal
- [Profile storage](mem://pi/runtime/profile-storage) — 4 oberoende kalibreringsprofiler lagrade på Pi:n via /api/profiles
- [PCC service contract](mem://pi/runtime/pcc-contract) — PCC äger runtime/portar/config/perms; tjänsten äger appkod + deps. PORT-fallback, PCC_CONFIG_DIR, services.json permissions
- [Settings survive updates](mem://pi/deployment/settings-survive-updates) — pi/data/ rörs aldrig av update/setup; storage.ts auto-migrerar mellan legacy-paths
- [Sonos stale-watchdog](mem://pi/sonos/stale-watchdog) — 10s watchdog tvingar PAUSED om status saknas i PLAYING (skydd mot fastnad output)
- [Saturation mapping](mem://technical/lighting/saturation-mapping) — Vit-rensning (min-channel subtract + peak-boost) bevarar hue, default saturation=1.0 i alla profiler
- [Idle-disconnect policy](mem://pi/runtime/idle-disconnect-policy) — Efter 2 min Sonos-paus: idle-färg @ 100% → BLE off → ALSA stop (~20-25% CPU). Reconnect bara via Sonos PLAYING om disconnect var auto. Manual UI-disconnect blockerar reconnect.
