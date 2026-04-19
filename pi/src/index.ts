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
  // VIKTIGT: vi tar AKTIVT upp adaptern (rfkill unblock + hciconfig up) om den
  // är nere — passiv väntan duger inte eftersom PCC's ExecStartPre kanske inte
  // har kört innan vår user-service startar. noble cachar `poweredOff` för
  // evigt om hci0 är DOWN vid första require().
  bt('STEP A: importing adapter-hci-check.js...');
  const { waitForHci0Up, isHci0Up, bringHci0Up } = await import('./ble/adapter-hci-check.js');
  bt('STEP A: import done, checking hci0...');
  if (!isHci0Up()) {
    bt('STEP A: hci0 DOWN — kör rfkill unblock + hciconfig hci0 up...');
    const upNow = bringHci0Up();
    bt(upNow ? 'STEP A: ✓ hci0 UP RUNNING (efter aktiv up)' : 'STEP A: hci0 fortfarande nere — pollar upp till 10s...');
    if (!upNow) {
      const up = await waitForHci0Up(10000);
      bt(up ? 'STEP A: ✓ hci0 UP RUNNING (efter poll)' : 'STEP A: ⚠ hci0 still down after 10s — fortsätter ändå');
    }
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

  // STEP B.1 — Starta configServer TIDIGT så UI:t kan visa boot-status
  // ("Bootar: väntar på Bluetooth…") medan vi väntar på noble. Engine
  // skapas också här (utan att start()as) så API:t har en referens.
  bt('STEP B.1: starting configServer + engine (engine NOT started yet)...');
  const { setBootPhase } = await import('./ble/state.js');
  const { PiLightEngine } = await import('./piEngine.js');
  const { startConfigServer } = await import('./configServer.js');
  const engine = new PiLightEngine(effectiveTickMs);
  startConfigServer(engine, CONFIG_PORT);
  bt('STEP B.1: configServer up — UI kan nu polla /api/status under väntan');

  // STEP B.2 — BLOCKERA tills noble rapporterar poweredOn. Inget annat
  // (alsaMic, Sonos, mic, engine.start) startas innan dess. Heartbeat var
  // 5:e sek så användaren ser att vi inte är hängda.
  bt('STEP B.2: blockerar boot tills noble.poweredOn (heartbeat var 5:e s)...');
  const { recordObservedNobleState, getNobleRawState, logConnectionEvent } = await import('./ble/state.js');
  const waitStart = Date.now();
  let waitIteration = 0;
  let firstState: string = 'unknown';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    waitIteration++;
    const elapsedSec = Math.round((Date.now() - waitStart) / 1000);
    console.log(`[Boot] Väntar på noble poweredOn (t+${elapsedSec}s, försök #${waitIteration})...`);
    logConnectionEvent({ type: 'connect_start', detail: `boot: väntar på noble poweredOn (t+${elapsedSec}s, försök #${waitIteration})` });

    const result = await Promise.race([
      waitForFirstStateChange(60_000),
      (async () => {
        try {
          await (noble as any).waitForPoweredOnAsync(60_000);
          recordObservedNobleState('poweredOn');
          return 'poweredOn';
        } catch {
          return 'wait-timeout';
        }
      })(),
    ]);

    const raw = getNobleRawState();
    if (result === 'poweredOn' || raw === 'poweredOn') {
      firstState = 'poweredOn';
      const totalSec = Math.round((Date.now() - waitStart) / 1000);
      bt(`STEP B.2: ✓ noble poweredOn efter ${totalSec}s (försök #${waitIteration})`);
      logConnectionEvent({ type: 'connect_start', detail: `boot: noble poweredOn efter ${totalSec}s` });
      break;
    }

    bt(`STEP B.2: noble fortfarande inte poweredOn (result=${result}, raw=${raw ?? 'null'}) — fortsätter vänta`);
    // Liten paus innan nästa iteration så vi inte spammar
    await new Promise((r) => setTimeout(r, 5000));
  }

  // STEP B.3 — NU är noble redo. Ladda alsaMic (native ALSA-bindning) och
  // applicera sparade settings.
  bt('STEP B.3: importing alsaMic (efter noble poweredOn)...');
  const alsaMic = await import('./alsaMic.js');
  startMic = alsaMic.startMic;
  stopMic = alsaMic.stopMic;
  setAlsaDevice = alsaMic.setAlsaDevice;
  setMicGain = alsaMic.setMicGain;
  setAutoGainFromVolume = alsaMic.setAutoGainFromVolume;
  if (savedAlsaDevice) setAlsaDevice(savedAlsaDevice);
  if (savedMicGain) { const g = parseFloat(savedMicGain); if (g >= 0.1 && g <= 50) setMicGain(g); }
  console.log('[Boot] ✓ alsaMic loaded');

  const { getAdapterState } = nobleBle;
  const effectiveState = getAdapterState();
  console.log(`[Boot] BLE redo (raw=${firstState}, eff=${effectiveState})`);

  console.log(`  BLE build: ${BLE_BUILD_TAG}`);
  console.log('');

  // BLE capabilities self-check
  const { runBleCapsSelfCheck, setHciProbeSnapshot } = await import('./ble/state.js');
  const capsCheck = runBleCapsSelfCheck();

  // HCI raw socket probe
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

  // Heartbeat-loggning
  const { startBleHeartbeat } = await import('./ble/heartbeat.js');
  startBleHeartbeat();

  // Apply dimming-gamma
  if (savedGamma) { const g = parseFloat(savedGamma); if (g >= 1 && g <= 3) setDimmingGamma(g); }

  console.log('');

  const { getSavedDeviceId } = await import('./ble/state.js');
  if (getSavedDeviceId()) {
    console.log(`[Boot] Saved device finns (${getSavedDeviceId()}) — noble HCI redo för auto-connect`);
  } else {
    console.log('[Boot] Ingen sparad enhet — noble HCI redo för scan via /api/ble/scan');
  }

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

    if (!state.isTvMode && state.palette && state.palette.length > 0 &&
        state.albumArtUrl && state.albumArtUrl !== lastArtUrl) {
      lastArtUrl = state.albumArtUrl;
      engine.setColor(state.palette[0]);
      engine.setPalette(state.palette);
      console.log(`[Color] Palette from gateway: ${state.palette.map(c => `rgb(${c})`).join(', ')}`);
    }
  });

  // Start mic NU (efter noble + Sonos är redo)
  console.log('[Boot] Starting ALSA microphone...');
  try {
    startMic();
  } catch (e: any) {
    console.error('[Boot] Mic failed (continuing without):', e.message);
  }

  // 6. Start engine + markera boot som klar
  engine.start();
  setBootPhase('ready');

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
    clearInterval(statsTimer);
    // releaseHci=true → tvinga full HCI-release även om demand fortfarande är på.
    // Adaptern ska vara helt ren när processen avslutas (PCC-restart, OS-shutdown).
    await disconnectAll(true);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[Boot] ✓ All systems running (manual-connect-only build)');
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
