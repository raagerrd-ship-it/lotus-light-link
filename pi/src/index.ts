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

import { startMic, stopMic, setAlsaDevice, setMicGain, setAutoGainFromVolume } from './alsaMic.js';
import { scanAndConnect, disconnectAll, startReconnectLoop, getConnectedCount, setDimmingGamma, setExpectedDeviceCount, requestConnect, releaseDemand } from './nobleBle.js';
import { startSonosPoller, stopSonosPoller, onSonosChange, setAutoTvMode as setSonosAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';
import { PiLightEngine } from './piEngine.js';
import { startConfigServer } from './configServer.js';
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

  const savedGamma = getItem('dimming-gamma');
  if (savedGamma) { const g = parseFloat(savedGamma); if (g >= 1 && g <= 3) setDimmingGamma(g); }

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
  console.log(`  Config API: :${CONFIG_PORT} (backend)`);
  

  console.log('');

  // 2. Create engine
  const engine = new PiLightEngine(effectiveTickMs);

  // 3. Start config server EARLY (so API is available during BLE/Sonos init)
  startConfigServer(engine, CONFIG_PORT);

  // 4. Start microphone
  console.log('[Boot] Starting ALSA microphone...');
  try {
    startMic();
  } catch (e: any) {
    console.error('[Boot] Mic failed (continuing without):', e.message);
  }

  // 5. BLE — don't connect at boot, wait for Sonos to signal playback
  console.log('[Boot] BLE ready (will connect on demand when music plays)');
  const reconnectTimer = startReconnectLoop(15000);

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
    await disconnectAll();
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
