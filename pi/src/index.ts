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
import { startSonosPoller, stopSonosPoller, onSonosChange } from './sonosPoller.js';
import { PiLightEngine } from './piEngine.js';
import { startConfigServer } from './configServer.js';

// --- Config ---
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3000/api/sonos';
const CONFIG_PORT = Number(process.env.CONFIG_PORT ?? 3001);
const TICK_MS = Number(process.env.TICK_MS ?? 30);

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Tick: ${TICK_MS}ms (${Math.round(1000 / TICK_MS)} Hz)`);
  console.log(`  Bridge: ${BRIDGE_URL}`);
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

  // 4. Start Sonos poller
  console.log('[Boot] Starting Sonos poller...');
  startSonosPoller(BRIDGE_URL);

  // React to Sonos state changes
  onSonosChange((state) => {
    const isPlaying = state.playbackState === 'PLAYBACK_STATE_PLAYING';
    engine.setPlaying(isPlaying);
    if (state.volume != null) engine.setVolume(state.volume);
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
