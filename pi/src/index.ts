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
import { startMic, stopMic, setAlsaDevice, setMicGain, setAutoGainFromVolume } from './alsaMic.js';
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
  const savedAlsaDevice = getItem('alsa-device');
  if (savedAlsaDevice) setAlsaDevice(savedAlsaDevice);

  // dimming-gamma restore moved below — needs setDimmingGamma which is
  // imported lazily after hci0 is up (avoids early noble init).
  const savedGamma = getItem('dimming-gamma');

  // Restore auto TV-mode setting
  const savedAutoTv = getItem('auto-tv-mode');
  if (savedAutoTv === 'true') setSonosAutoTvMode(true);

  const savedMicGain = getItem('mic-gain');
  if (savedMicGain) { const g = parseFloat(savedMicGain); if (g >= 0.1 && g <= 50) setMicGain(g); }

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

  // STEP A: Wait for hci0 BEFORE loading anything that touches noble.
  // adapter-hci-check.ts is standalone (no noble import) so this poll runs
  // without triggering noble's HCI bindings init.
  const { waitForHci0Up, isHci0Up } = await import('./ble/adapter-hci-check.js');
  if (!isHci0Up()) {
    console.log('[Boot] Väntar på att hci0 ska bli UP RUNNING (max 10s)...');
    const up = await waitForHci0Up(10000);
    console.log(up
      ? '[Boot] ✓ hci0 UP RUNNING — laddar noble nu'
      : '[Boot] ⚠ hci0 fortfarande nere efter 10s — laddar noble ändå (BLE kan kräva manuell "Återställ BLE-stack")');
  } else {
    console.log('[Boot] ✓ hci0 redan UP RUNNING');
  }

  // STEP B: NOW it's safe to import noble + everything that depends on it.
  // These dynamic imports cause noble to init in a process where hci0 is up.
  const nobleBle = await import('./nobleBle.js');
  const {
    scanAndConnect, disconnectAll, startReconnectLoop, getConnectedCount,
    setDimmingGamma, setExpectedDeviceCount, requestConnect, releaseDemand,
    BLE_BUILD_TAG,
  } = nobleBle;
  const { PiLightEngine } = await import('./piEngine.js');
  const { startConfigServer } = await import('./configServer.js');

  console.log(`  BLE build: ${BLE_BUILD_TAG}`);
  console.log('');

  // BLE capabilities self-check — varnar tydligt om systemd-tjänsten saknar
  // CAP_NET_RAW/CAP_NET_ADMIN så vi inte gissar på "varför funkar inte BLE?".
  const { runBleCapsSelfCheck } = await import('./ble/state.js');
  runBleCapsSelfCheck();

  console.log('');

  // 2. Create engine
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
