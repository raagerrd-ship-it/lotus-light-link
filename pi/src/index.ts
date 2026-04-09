#!/usr/bin/env node
/**
 * Lotus Light Link — Headless Pi runtime
 * 
 * Runs on Raspberry Pi Zero 2 W with:
 * - INMP441 I²S MEMS microphone (ALSA)
 * - BLEDOM LED strips via noble
 * - Sonos now-playing via Cast Away bridge SSE
 * - Config API on :3001
 */

import { installLocalStorageShim } from './storage.js';

// Install shims before any engine imports
installLocalStorageShim();

import { startMic, stopMic, setAlsaDevice } from './alsaMic.js';
import { scanAndConnect, disconnectAll, startReconnectLoop, getConnectedCount, setDimmingGamma, setExpectedDeviceCount } from './nobleBle.js';
import { startSonosPoller, stopSonosPoller, onSonosChange, setAutoTvMode as setSonosAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';
import { PiLightEngine } from './piEngine.js';
import { startConfigServer } from './configServer.js';
import { getItem, setItem } from './storage.js';
import { extractPalette } from './colorExtract.js';

// --- Config ---
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3000/api/sonos';
const CONFIG_PORT = Number(process.env.CONFIG_PORT ?? 3001);
const TICK_MS = Number(process.env.TICK_MS ?? 30);
const SSE_PATH = process.env.SSE_PATH ?? '/events';
const STATUS_PATH = process.env.STATUS_PATH ?? '/status';
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const DISABLE_SSE = process.env.DISABLE_SSE === 'true';

async function main() {
  // 1. Restore persisted global settings (before banner so we can show effective values)
  const savedAlsaDevice = getItem('alsa-device');
  if (savedAlsaDevice) setAlsaDevice(savedAlsaDevice);

  const savedGamma = getItem('dimming-gamma');
  if (savedGamma) { const g = parseFloat(savedGamma); if (g >= 1 && g <= 3) setDimmingGamma(g); }

  // Restore auto TV-mode setting
  const savedAutoTv = getItem('auto-tv-mode');
  if (savedAutoTv === 'true') setSonosAutoTvMode(true);

  const savedTickMs = getItem('tick-ms');
  const effectiveTickMs = savedTickMs ? Math.max(20, Math.min(200, Number(savedTickMs))) : TICK_MS;

  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Tick: ${effectiveTickMs}ms (${Math.round(1000 / effectiveTickMs)} Hz)${savedTickMs ? ' (saved)' : ''}`);
  console.log(`  Bridge: ${BRIDGE_URL}`);
  console.log(`  SSE: ${DISABLE_SSE ? 'disabled' : SSE_PATH} | Poll: ${POLL_INTERVAL}ms`);
  console.log(`  Config: :${CONFIG_PORT}`);
  console.log('');

  // 2. Create engine
  const engine = new PiLightEngine(effectiveTickMs);

  // 3. Start microphone
  console.log('[Boot] Starting ALSA microphone...');
  try {
    startMic();
  } catch (e: any) {
    console.error('[Boot] Mic failed (continuing without):', e.message);
  }

  // 4. Scan for BLE devices (non-fatal)
  console.log('[Boot] Scanning for BLEDOM devices...');
  try {
    const found = await scanAndConnect(15000);
    console.log(`[Boot] Found ${found} BLE device(s)`);
    setExpectedDeviceCount(found);
  } catch (e: any) {
    console.error('[Boot] BLE scan failed (continuing):', e.message);
  }

  // Start background reconnect loop
  const reconnectTimer = startReconnectLoop(30000);

  // 4. Start Sonos poller (configurable gateway)
  // Load saved config or use env vars
  let sonosConfig: SonosPollerConfig = {
    baseUrl: BRIDGE_URL,
    ssePath: SSE_PATH,
    statusPath: STATUS_PATH,
    pollIntervalMs: POLL_INTERVAL,
    disableSSE: DISABLE_SSE,
  };
  try {
    const saved = getItem('sonos-gateway');
    if (saved) sonosConfig = { ...sonosConfig, ...JSON.parse(saved) };
  } catch {}

  console.log('[Boot] Starting Sonos poller...');
  await startSonosPoller(sonosConfig);

  // React to Sonos state changes
  let lastArtUrl: string | null = null;
  let wasTvMode = false;
  onSonosChange((state) => {
    const isPlaying = state.playbackState === 'PLAYBACK_STATE_PLAYING';
    
    if (state.isTvMode) {
      // TV-mode: keep engine running with mic-reactive lighting, skip palette
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
    
    if (state.volume != null) engine.setVolume(state.volume);

    // Extract palette from album art on track change (skip in TV-mode)
    if (!state.isTvMode && state.albumArtUrl && state.albumArtUrl !== lastArtUrl) {
      lastArtUrl = state.albumArtUrl;
      extractPalette(state.albumArtUrl, 4).then((palette) => {
        if (palette.length > 0) {
          engine.setColor(palette[0]);
          engine.setPalette(palette);
          console.log(`[Color] Palette from art: ${palette.map(c => `rgb(${c})`).join(', ')}`);
        }
      }).catch(() => {});
    }
  });

  // 5. Start engine
  engine.start();

  // 6. Start config server
  startConfigServer(engine, CONFIG_PORT);

  // 7. Stats logging
  const statsTimer = setInterval(() => {
    const ble = getConnectedCount();
    console.log(`[Stats] BLE: ${ble} device(s) | Engine: ${engine.getTickMs()}ms tick`);
  }, 60000);

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
