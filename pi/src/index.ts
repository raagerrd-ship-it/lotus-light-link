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

import { startMic, stopMic } from './alsaMic.js';
import { scanAndConnect, disconnectAll, startReconnectLoop, getConnectedCount } from './nobleBle.js';
import { startSonosPoller, stopSonosPoller, onSonosChange, type SonosPollerConfig } from './sonosPoller.js';
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
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Tick: ${TICK_MS}ms (${Math.round(1000 / TICK_MS)} Hz)`);
  console.log(`  Bridge: ${BRIDGE_URL}`);
  console.log(`  SSE: ${DISABLE_SSE ? 'disabled' : SSE_PATH} | Poll: ${POLL_INTERVAL}ms`);
  console.log(`  Config: :${CONFIG_PORT}`);
  console.log('');

  // 1. Create engine
  const engine = new PiLightEngine(TICK_MS);

  // 2. Start microphone
  console.log('[Boot] Starting ALSA microphone...');
  startMic();

  // 3. Scan for BLE devices
  console.log('[Boot] Scanning for BLEDOM devices...');
  const found = await scanAndConnect(15000);
  console.log(`[Boot] Found ${found} BLE device(s)`);

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
  onSonosChange((state) => {
    const isPlaying = state.playbackState === 'PLAYBACK_STATE_PLAYING';
    engine.setPlaying(isPlaying);
    if (state.volume != null) engine.setVolume(state.volume);

    // Extract palette from album art on track change
    if (state.albumArtUrl && state.albumArtUrl !== lastArtUrl) {
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
    console.log(`[Stats] BLE: ${ble} device(s) | Engine: ${TICK_MS}ms tick`);
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
