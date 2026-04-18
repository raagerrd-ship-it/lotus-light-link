#!/usr/bin/env node
/**
 * Lotus Light Link — Headless Pi runtime
 *
 * Runs on Raspberry Pi Zero 2 W with:
 * - INMP441 I²S MEMS microphone (ALSA)
 * - BLEDOM LED strips via noble (fixed: removed state mutation that broke startScanningAsync)
 * - Sonos now-playing via Cast Away bridge SSE
 * - Config API on :3050 (or PORT env var)
 */

import { installLocalStorageShim } from './storage.js';

// Install shims before any engine imports
installLocalStorageShim();

// IMPORTANT: noble (via nobleBle.js / ble/state.ts) must NOT be imported at
// top level. noble runs its HCI init synchronously on first require(), and if
// hci0 is still DOWN at that moment it caches `poweredOff` forever in this
// process. We therefore import everything that touches noble lazily inside
// main(), AFTER waitForHci0Up() has confirmed the adapter is UP RUNNING.
// alsaMic importeras LAZY inuti main() — top-level import drar igång den
// native C++ ALSA-bindningen synkront, vilket blockerar libuv-event-loopen
// och äter noble's första `stateChange`-event (verifierat i SSH-test:
// fristående script → state=poweredOn på 1.5s; med native-bindning laddad
// tidigt → fastnar i `unknown` för alltid).
import type { startMic as StartMicT, stopMic as StopMicT, setAlsaDevice as SetAlsaDeviceT, setMicGain as SetMicGainT, setAutoGainFromVolume as SetAutoGainFromVolumeT } from './alsaMic.js';
let startMic!: typeof StartMicT;
let stopMic!: typeof StopMicT;
let setAlsaDevice!: typeof SetAlsaDeviceT;
let setMicGain!: typeof SetMicGainT;
let setAutoGainFromVolume!: typeof SetAutoGainFromVolumeT;
import { startSonosPoller, stopSonosPoller, onSonosChange, setAutoTvMode as setSonosAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';
import { getItem, setItem } from './storage.js';
// Palette now comes from Sonos Gateway response (no cloud call needed)

// --- Config ---
const SONOS_BUDDY_API_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:3053/api';
const LEGACY_LOCAL_SONOS_URLS = new Set([
  'http://172.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3002/api/sonos',
  'http://127.0.0.1:3053/api/sonos',
  'http://127.0.0.1:3052/api/sonos',
]);
// Pi Control Center sets PORT; legacy uses BACKEND_PORT
const CONFIG_PORT = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3050);
const SSE_PATH = process.env.SSE_PATH ?? '/events';
const STATUS_PATH = process.env.STATUS_PATH ?? '/status';
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const DISABLE_SSE = process.env.DISABLE_SSE === 'true';
const TICK_MS = 10; // default tick rate (ms) — 100 Hz for maximum responsiveness

function normalizeSonosConfig(config: Partial<SonosPollerConfig> | null | undefined): SonosPollerConfig {
  const rawBaseUrl = typeof config?.baseUrl === 'string' && config.baseUrl.trim().length > 0
    ? config.baseUrl.trim().replace(/\/$/, '')
    : SONOS_BUDDY_API_URL;

  const baseUrl = LEGACY_LOCAL_SONOS_URLS.has(rawBaseUrl) ? SONOS_BUDDY_API_URL : rawBaseUrl;

  return {
    baseUrl,
    ssePath: config?.ssePath ?? SSE_PATH,
    statusPath: config?.statusPath ?? STATUS_PATH,
    pollIntervalMs: config?.pollIntervalMs ?? POLL_INTERVAL,
    pollTimeoutMs: config?.pollTimeoutMs,
    disableSSE: config?.disableSSE ?? DISABLE_SSE,
  };
}

async function main() {
  // 1. Restore persisted global settings (before banner so we can show effective values)
  // OBS: setAlsaDevice/setMicGain anropas LÄNGRE NER, efter alsaMic lazy-importeras.
  // De ROHA värdena läses här så de inte går förlorade.
  const savedAlsaDevice = getItem('alsa-device');

  // dimming-gamma restore moved below — needs setDimmingGamma which is
  // imported lazily after hci0 is up (avoids early noble init).
  const savedGamma = getItem('dimming-gamma');

  // Restore auto TV-mode setting
  const savedAutoTv = getItem('auto-tv-mode');
  if (savedAutoTv === 'true') setSonosAutoTvMode(true);

  const savedMicGain = getItem('mic-gain');
  // savedMicGain tillämpas tillsammans med savedAlsaDevice EFTER
  // waitForFirstStateChange — annars laddas alsaMic native-bindningen för
  // tidigt och blockerar noble's libuv-stateChange.

  const savedTickMs = getItem('tick-ms');
  const effectiveTickMs = savedTickMs ? Math.max(10, Math.min(50, Number(savedTickMs))) : TICK_MS;

  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Tick: ${effectiveTickMs}ms (${Math.round(1000 / effectiveTickMs)} Hz)${savedTickMs ? ' (saved)' : ''}`);
  console.log(`  Bridge: ${SONOS_BUDDY_API_URL}`);
  console.log(`  SSE: ${DISABLE_SSE ? 'disabled' : SSE_PATH} | Poll: ${POLL_INTERVAL}ms`);
  console.log(`  Config API: :${CONFIG_PORT} (backend)${process.env.PORT ? ' [from env PORT]' : process.env.BACKEND_PORT ? ' [from env BACKEND_PORT]' : ' [default]'}`);

  console.log('');

  // ── BOOT TIMING DIAGNOSTIC ──
  // Logga exakt hur lång tid varje steg tar så vi kan se var libuv blockeras.
  const bootT0 = Date.now();
  const bt = (label: string) => console.log(`[BootTime +${(Date.now() - bootT0).toString().padStart(5, ' ')}ms] ${label}`);

  // STEP A: Wait for hci0 BEFORE loading anything that touches noble.
  bt('STEP A: importing adapter-hci-check.js...');
  const { waitForHci0Up, isHci0Up } = await import('./ble/adapter-hci-check.js');
  bt('STEP A: import done, checking hci0...');
  if (!isHci0Up()) {
    bt('STEP A: hci0 DOWN — waiting up to 10s for UP RUNNING...');
    const up = await waitForHci0Up(10000);
    bt(up ? 'STEP A: ✓ hci0 UP RUNNING' : 'STEP A: ⚠ hci0 still down after 10s');
  } else {
    bt('STEP A: ✓ hci0 already UP RUNNING');
  }

  // STEP B: import noble. This is when @stoprocent/noble's HCI binding fires up.
  bt('STEP B: importing nobleBle.js (this triggers noble HCI init)...');
  const nobleBle = await import('./nobleBle.js');
  bt('STEP B: nobleBle.js import done');
  const {
    scanAndConnect, disconnectAll, getConnectedCount,
    setDimmingGamma, setExpectedDeviceCount,
    BLE_BUILD_TAG, waitForFirstStateChange, noble,
  } = nobleBle;

  // STEP B.1 — Wait for noble to actually power on. Two mechanisms in parallel:
  //   (a) cached stateChange listener (set up at top of state.ts)
  //   (b) noble's own waitForPoweredOnAsync — proven working in SSH replica test
  // Whichever resolves first wins.
  bt('STEP B.1: awaiting noble stateChange (cached + waitForPoweredOnAsync race, 30s)...');
  const { recordObservedNobleState } = await import('./ble/state.js');
  const firstState = await Promise.race([
    waitForFirstStateChange(30000),
    (async () => {
      try {
        await (noble as any).waitForPoweredOnAsync(30000);
        recordObservedNobleState('poweredOn');
        return 'poweredOn';
      } catch {
        return 'wait-timeout';
      }
    })(),
  ]);
  bt(`STEP B.1: ✓ first stateChange resolved = ${firstState}`);
  console.log(`[Boot] noble.state after wait = ${(noble as any).state}`);

  // STEP B.2 — NU är det säkert att ladda alsaMic. Native ALSA-bindningen
  // gör synkron init som annars hade blockerat libuv och ätit noble's
  // stateChange (verifierat i SSH-test).
  const alsaMic = await import('./alsaMic.js');
  startMic = alsaMic.startMic;
  stopMic = alsaMic.stopMic;
  setAlsaDevice = alsaMic.setAlsaDevice;
  setMicGain = alsaMic.setMicGain;
  setAutoGainFromVolume = alsaMic.setAutoGainFromVolume;
  if (savedAlsaDevice) setAlsaDevice(savedAlsaDevice);
  if (savedMicGain) { const g = parseFloat(savedMicGain); if (g >= 0.1 && g <= 50) setMicGain(g); }
  console.log('[Boot] ✓ alsaMic loaded (efter noble stateChange)');

  // Auto-restore BLE master switch om användaren hade radion PÅ före senaste
  // restart OCH noble faktiskt är poweredOn nu. Annars håller vi den OFF —
  // användaren får trycka på knappen manuellt så de ser felmeddelandet.
  const { wasEnabledBeforeRestart, setBleEnabled, ensureAdapterUp, autoConnectSaved, getAdapterState } = nobleBle;
  // På Pi blir rå noble.state ofta aldrig poweredOn (fastnar i `unknown`).
  // Effektiv adapter-state (caps-aware) är det som verkligen räknas — om
  // den rapporterar poweredOn så ÄR adaptern användbar oavsett rå-state.
  const effectiveState = getAdapterState();
  const canEnable = firstState === 'poweredOn' || effectiveState === 'poweredOn';
  if (wasEnabledBeforeRestart() && canEnable) {
    setBleEnabled(true, false); // persist=false → vi rör inte storage vid auto-restore
    console.log(`[Boot] ✓ BLE master switch auto-restored till ON (raw=${firstState}, eff=${effectiveState})`);
    // Förbered adaptern + starta auto-connect i bakgrunden så sparad enhet
    // kopplas upp utan att användaren behöver röra UI:t.
    void (async () => {
      try {
        const ready = await ensureAdapterUp();
        if (ready) {
          const n = await autoConnectSaved(10000);
          console.log(`[Boot] auto-restore connect: ${n > 0 ? 'connected' : 'no saved device or failed'}`);
        }
      } catch (e: any) {
        console.error('[Boot] auto-restore connect failed:', e?.message ?? e);
      }
    })();
  } else if (wasEnabledBeforeRestart()) {
    console.log(`[Boot] ⚠ BLE var PÅ före restart men adapter ej redo (raw=${firstState}, eff=${effectiveState}) — väntar på manuell aktivering`);
  }

  const { PiLightEngine } = await import('./piEngine.js');
  const { startConfigServer } = await import('./configServer.js');

  console.log(`  BLE build: ${BLE_BUILD_TAG}`);
  console.log('');

  // BLE capabilities self-check — varnar tydligt om systemd-tjänsten saknar
  // CAP_NET_RAW/CAP_NET_ADMIN så vi inte gissar på "varför funkar inte BLE?".
  const { runBleCapsSelfCheck, logConnectionEvent, setHciProbeSnapshot } = await import('./ble/state.js');
  const capsCheck = runBleCapsSelfCheck();

  // HCI raw socket probe — ground truth-test som gör samma syscall som
  // noble's native binding. Om denna failar med EPERM så hjälper inte
  // ens setcap på node-binären, och vi vet att problemet sitter på
  // kernel-/LSM-/AppArmor-nivå (inte i vår caps-config).
  try {
    const { probeHciSocket } = await import('./ble/hci-socket-probe.js');
    const probe = probeHciSocket();
    setHciProbeSnapshot({
      ok: probe.ok,
      method: probe.method,
      errno: probe.errno,
      error: probe.error,
      details: probe.details,
    });
    if (probe.ok) {
      console.log(`[BLE:hci-probe] ✓ HCI raw socket OK (${probe.method})`);
      logConnectionEvent({ type: 'connect_start', detail: `hci-probe OK: ${probe.details ?? probe.method}` });
    } else {
      console.error(`[BLE:hci-probe] ✗ HCI raw socket FAILED: ${probe.error}`);
      logConnectionEvent({
        type: 'connect_fail',
        detail: `hci-probe FAIL (${probe.method}): ${probe.error}${capsCheck.hasCaps ? ' — CapEff säger OK men socket() failar ändå' : ''}`,
      });
    }
  } catch (e: any) {
    console.error('[BLE:hci-probe] probe crashed:', e?.message ?? e);
  }

  // Starta heartbeat-loggning så UI:t alltid har löpande status att visa
  // även när noble fastnat eller ingen connect-aktivitet pågår.
  const { startBleHeartbeat } = await import('./ble/heartbeat.js');
  startBleHeartbeat();

  // Apply dimming-gamma now that setDimmingGamma is available.
  if (savedGamma) { const g = parseFloat(savedGamma); if (g >= 1 && g <= 3) setDimmingGamma(g); }

  console.log('');

  const engine = new PiLightEngine(effectiveTickMs);

  // 3. Start config server EARLY (so API is available during BLE/Sonos init)
  startConfigServer(engine, CONFIG_PORT);

  console.log('[Boot] Starting ALSA microphone...');
  try {
    startMic();
  } catch (e: any) {
    console.error('[Boot] Mic failed (continuing without):', e.message);
  }

  // 5. BLE — start reconnect-loop FIRST so any demand-event under boot
  // (Sonos already playing) blir uppfångat även om första connect missar.
  // Loopen tickar var 15s och anropar autoConnectSaved när demand är aktiv.
  const reconnectTimer = startReconnectLoop(15000);

  // Do NOT touch BLE during boot. The isolated noble one-liner works because
  // it simply loads noble and waits for stateChange. Boot-time adapter prep
  // races that startup path on Raspberry Pi and can wedge noble in poweredOff.
  console.log('[Boot] Leaving Bluetooth adapter untouched until first BLE action');

  // 5. Start Sonos poller (configurable gateway)
  let sonosConfig = normalizeSonosConfig({});
  try {
    const saved = getItem('sonos-gateway');
    if (saved) {
      const parsed = JSON.parse(saved);
      const normalized = normalizeSonosConfig(parsed);
      sonosConfig = normalized;
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        setItem('sonos-gateway', JSON.stringify(normalized));
        console.log(`[Boot] Migrated Sonos gateway URL → ${normalized.baseUrl}`);
      }
    }
  } catch {}

  console.log('[Boot] Starting Sonos poller...');
  try {
    await startSonosPoller(sonosConfig);
  } catch (e: any) {
    console.error('[Boot] Sonos poller failed (continuing):', e.message);
  }

  // React to Sonos state changes
  let lastArtUrl: string | null = null;
  let wasTvMode = false;
  onSonosChange((state) => {
    const isPlaying = state.playbackState === 'PLAYBACK_STATE_PLAYING';
    const needsBle = isPlaying || state.isTvMode;
    
    // Demand-based BLE: connect when needed, stop reconnecting when idle
    if (needsBle) {
      requestConnect();
    } else {
      releaseDemand();
    }
    
    if (state.isTvMode) {
      engine.setPlaying(true);
      if (!wasTvMode) {
        console.log('[Engine] → TV-läge (mikrofon-reaktiv)');
        wasTvMode = true;
      }
    } else {
      engine.setPlaying(isPlaying);
      if (wasTvMode) {
        console.log('[Engine] TV-läge → Normal');
        wasTvMode = false;
      }
    }
    
    if (state.volume != null) {
      engine.setVolume(state.volume);
      setAutoGainFromVolume(state.volume);
    }

    // Use palette from Sonos Gateway response
    if (!state.isTvMode && state.palette && state.palette.length > 0 &&
        state.albumArtUrl && state.albumArtUrl !== lastArtUrl) {
      lastArtUrl = state.albumArtUrl;
      engine.setColor(state.palette[0]);
      engine.setPalette(state.palette);
      console.log(`[Color] Palette from gateway: ${state.palette.map(c => `rgb(${c})`).join(', ')}`);
    }
  });

  // 6. Start engine
  engine.start();

  // 7. Stats logging
  const statsTimer = setInterval(() => {
    const ble = getConnectedCount();
    console.log(`[Stats] BLE: ${ble} device(s) | Engine: ${engine.getTickMs()}ms tick`);
  }, 300_000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Cleaning up...');
    engine.stop();
    stopMic();
    stopSonosPoller();
    clearInterval(reconnectTimer);
    clearInterval(statsTimer);
    // releaseHci=true → tvinga full HCI-release även om demand fortfarande är på.
    // Adaptern ska vara helt ren när processen avslutas (PCC-restart, OS-shutdown).
    await disconnectAll(true);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[Boot] ✓ All systems running');
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
