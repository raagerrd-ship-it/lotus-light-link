/**
 * Config server — Express API for mobile configuration.
 * API-only — the web UI is served by a separate frontend process.
 */

import { readFileSync } from 'fs';
import express from 'express';
import { getItem, setItem } from './storage.js';
import {
  bleStats, BLE_BUILD_TAG,
  setDimmingGamma, getDimmingGamma, sendRawColor,
  getMinWriteIntervalMs, setMinWriteIntervalMs,
  getAllSubsystemStates, getSubsystemState, type SubsystemId,
} from './ble/index.js';
import type { GainCalPoint } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, getLastSuccessfulPollAt as getSonosLastPollAt, type SonosPollerConfig } from './sonosPoller.js';


type AlsaMicModule = typeof import('./alsaMic.js');

let attachedEngine: PiLightEngine | null = null;
let attachedMic: AlsaMicModule | null = null;
let invalidateIdleColorCacheFn: (() => void) | null = null;

export interface SubsystemStarters {
  startMic: () => Promise<void>;
  startSonos: () => Promise<void>;
}
let _starters: SubsystemStarters | null = null;
export function attachSubsystemStarters(s: SubsystemStarters): void {
  _starters = s;
  console.log('[Config] subsystem starters attached');
}

export function attachConfigRuntime(runtime: {
  engine: PiLightEngine;
  mic: AlsaMicModule;
  invalidateIdleColorCache?: () => void;
}): void {
  attachedEngine = runtime.engine;
  attachedMic = runtime.mic;
  invalidateIdleColorCacheFn = runtime.invalidateIdleColorCache ?? null;

  try {
    const saved = getItem('gain-cal-points');
    if (saved) {
      const { point1, point2 } = JSON.parse(saved);
      attachedMic.setGainCalPoints(point1 ?? null, point2 ?? null);
    }
  } catch {}

  console.log('[Config] Runtime attached (engine + mic)');
}

// Version info — cached at boot.
let SERVICE_VERSION = '1.0.0';
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
const START_TIME = Date.now();
let lastVersionRefreshAt = 0;
const VERSION_REFRESH_TTL_MS = 60_000;
let versionWarningLogged = false;

function readVersionFileOnce(): boolean {
  const paths = [
    '/opt/lotus-light/VERSION.json',
    new URL('../VERSION.json', import.meta.url).pathname,
    new URL('../../VERSION.json', import.meta.url).pathname,
  ];
  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf8');
      const vf = JSON.parse(raw);
      if (vf.version) {
        SERVICE_VERSION = vf.version;
        GIT_COMMIT = vf.commit ?? GIT_COMMIT;
        GIT_COMMIT_SHORT = vf.commitShort ?? (typeof vf.commit === 'string' ? vf.commit.substring(0, 7) : GIT_COMMIT_SHORT);
        GIT_BRANCH = vf.branch ?? GIT_BRANCH;
        return true;
      }
    } catch {
      // try next path
    }
  }
  return false;
}

function refreshVersionInfo(): void {
  const now = Date.now();
  if (now - lastVersionRefreshAt < VERSION_REFRESH_TTL_MS) return;
  lastVersionRefreshAt = now;
  const ok = readVersionFileOnce();
  if (!ok && !versionWarningLogged) {
    versionWarningLogged = true;
    console.warn(`[Config] VERSION.json not found — using fallback v${SERVICE_VERSION}/${GIT_COMMIT_SHORT}`);
  }
}

readVersionFileOnce();
lastVersionRefreshAt = Date.now();

export function startConfigServer(port = 3050): void {
  const getEngine = () => attachedEngine;
  const getMic = () => attachedMic;
  const requireEngine = (res: any): PiLightEngine | null => {
    if (attachedEngine) return attachedEngine;
    res.status(503).json({ error: 'Engine bootar fortfarande — försök igen om en stund' });
    return null;
  };
  const requireMic = (res: any): AlsaMicModule | null => {
    if (attachedMic) return attachedMic;
    res.status(503).json({ error: 'Mikrofonmodulen laddas efter BLE-init — försök igen om en stund' });
    return null;
  };

  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // ─── Subsystem manual-start API (mic + sonos) ───
  app.get('/api/subsystem/status', (_req, res) => {
    res.json({ subsystems: getAllSubsystemStates() });
  });

  const startSubsystem = async (id: SubsystemId, res: any) => {
    if (!_starters) {
      return res.status(503).json({ error: 'Subsystem-starters inte attachade ännu' });
    }
    const before = getSubsystemState(id);
    if (before.status === 'ready') {
      return res.json({ ok: true, alreadyReady: true, subsystem: before });
    }
    try {
      if (id === 'mic') await _starters.startMic();
      else if (id === 'sonos') await _starters.startSonos();
      else return res.status(400).json({ error: `Okänt subsystem: ${id}` });
      res.json({ ok: true, subsystem: getSubsystemState(id) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e), subsystem: getSubsystemState(id) });
    }
  };

  app.post('/api/subsystem/mic/start',   (_req, res) => startSubsystem('mic', res));
  app.post('/api/subsystem/sonos/start', (_req, res) => startSubsystem('sonos', res));

  // --- Health (Pi Control Center standard) ---
  app.get('/api/health', async (_req, res) => {
    refreshVersionInfo();
    const mem = process.memoryUsage();
    const { getHardcodedConnected } = await import('./ble/connect-hardcoded.js');
    const c = getHardcodedConnected();
    const rss = Math.round(mem.rss / 1024 / 1024);

    let status: 'ok' | 'degraded' | 'error' = 'ok';
    if (rss > 100) status = 'degraded';

    res.json({
      status,
      service: 'lotus-light-engine',
      version: SERVICE_VERSION,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      memory: {
        rss,
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      ble: {
        connected: c.connected ? 1 : 0,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // --- Status (full app status) ---
  app.get('/api/status', async (_req, res) => {
    refreshVersionInfo();
    const sonos = getSonosState();
    const engine = getEngine();
    const { getHardcodedConnected } = await import('./ble/connect-hardcoded.js');
    const c = getHardcodedConnected();
    res.json({
      ok: true,
      ble: {
        connected: c.connected ? 1 : 0,
        devices: c.connected ? [c.name] : [],
        stats: bleStats,
      },
      commit: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
      version: SERVICE_VERSION,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      startedAt: new Date(START_TIME).toISOString(),
      sonos,
      engine: engine
        ? {
            running: true,
            tickMs: engine.getTickMs(),
            hz: Math.round(1000 / engine.getTickMs()),
            palette: engine.getPalette(),
          }
        : {
            running: false,
            tickMs: null,
            hz: null,
            palette: [],
          },
    });
  });

  // --- Version ---
  app.get('/api/version', (_req, res) => {
    refreshVersionInfo();
    res.json({
      name: 'lotus-light-link',
      version: SERVICE_VERSION,
      commit: GIT_COMMIT,
      commitShort: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Hardcoded BLE flow — den enda flödet UI:t använder.
  //
  // POST /api/ble/engine/start  → lazy-laddar noble + väntar poweredOn
  // POST /api/ble/connect        → scan-then-connect mot HARDCODED_DEVICE
  // POST /api/ble/disconnect     → kopplar från
  // GET  /api/ble/state          → { engineReady, connected, device }
  // ─────────────────────────────────────────────────────────────────────
  app.post('/api/ble/engine/start', async (_req, res) => {
    try {
      const { startBleEngineMinimal } = await import('./ble/engine-start-minimal.js');
      const r = await startBleEngineMinimal();
      if (r.ready) {
        res.json({ ready: true, durationMs: r.durationMs, rawState: r.rawState });
      } else {
        res.status(500).json({ ready: false, durationMs: r.durationMs, rawState: r.rawState, error: r.error });
      }
    } catch (e: any) {
      console.error('engine/start FEL:', e?.message ?? e);
      res.status(500).json({ ready: false, error: e?.message ?? String(e) });
    }
  });

  app.post('/api/ble/connect', async (_req, res) => {
    try {
      const { connectHardcoded } = await import('./ble/connect-hardcoded.js');
      const { HARDCODED_DEVICE } = await import('./ble/hardcoded-device.js');
      const r = await connectHardcoded(8000);
      if (r.connected) {
        res.json({ connected: true, name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac, durationMs: r.durationMs });
      } else {
        res.status(500).json({ connected: false, error: r.error, durationMs: r.durationMs });
      }
    } catch (e: any) {
      res.status(500).json({ connected: false, error: e?.message ?? String(e) });
    }
  });

  app.post('/api/ble/disconnect', async (_req, res) => {
    try {
      const { disconnectHardcoded } = await import('./ble/connect-hardcoded.js');
      const r = await disconnectHardcoded();
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ disconnected: false, error: e?.message ?? String(e) });
    }
  });

  app.get('/api/ble/state', async (_req, res) => {
    try {
      const { getHardcodedConnected } = await import('./ble/connect-hardcoded.js');
      const { hasNobleLoaded } = await import('./ble/state.js');
      const { HARDCODED_DEVICE } = await import('./ble/hardcoded-device.js');
      let rawState: string | null = null;
      let engineReady = false;
      if (hasNobleLoaded()) {
        const { getNoble } = await import('./ble/noble-singleton.js');
        rawState = getNoble().state ?? null;
        engineReady = rawState === 'poweredOn';
      }
      const c = getHardcodedConnected();
      res.json({
        engineReady,
        connected: c.connected,
        device: { name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac },
        rawState,
      });
    } catch (e: any) {
      res.status(500).json({ engineReady: false, connected: false, error: e?.message ?? String(e) });
    }
  });

  app.get('/api/calibration', (_req, res) => {
    const raw = getItem('light-calibration');
    res.json(raw ? JSON.parse(raw) : {});
  });

  app.put('/api/calibration', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const current = getItem('light-calibration');
    const merged = { ...(current ? JSON.parse(current) : {}), ...req.body };
    setItem('light-calibration', JSON.stringify(merged));
    engine.reloadCalibration();
    res.json({ ok: true });
  });

  // --- Raw mode (for gain calibration) ---
  app.put('/api/raw-mode', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const on = !!req.body.enabled;
    engine.setRawMode(on);
    res.json({ ok: true, rawMode: on });
  });

  app.get('/api/raw-mode', (_req, res) => {
    const engine = getEngine();
    res.json({ enabled: engine ? engine.isRawMode() : false });
  });

  // --- Color ---
  app.put('/api/color', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const { r, g, b } = req.body;
    if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
      engine.setColor([r, g, b]);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Need r, g, b' });
    }
  });

  // --- Idle color ---
  app.get('/api/idle-color', (_req, res) => {
    const raw = getItem('idle-color');
    res.json(raw ? JSON.parse(raw) : [255, 60, 0]);
  });

  app.put('/api/idle-color', (req, res) => {
    const { color } = req.body;
    if (Array.isArray(color) && color.length === 3) {
      setItem('idle-color', JSON.stringify(color));
      invalidateIdleColorCacheFn?.();
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Need color: [r,g,b]' });
    }
  });

  // --- Tick rate ---
  app.put('/api/tick-ms', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const { tickMs } = req.body;
    if (typeof tickMs === 'number' && tickMs >= 5 && tickMs <= 50) {
      engine.setTickMs(tickMs);
      engine.restartTimer();
      setItem('tick-ms', String(tickMs));
      res.json({ ok: true, tickMs, minWriteIntervalMs: Math.max(5, Math.floor(tickMs * 0.6)) });
    } else {
      res.status(400).json({ error: 'tickMs must be 5-50 (rate-limit auto-följer)' });
    }
  });

  // --- BLE write rate-limit ---
  app.get('/api/ble/rate-limit', (_req, res) => {
    const ms = getMinWriteIntervalMs();
    res.json({ minWriteIntervalMs: ms, maxHz: +(1000 / ms).toFixed(1) });
  });

  app.put('/api/ble/rate-limit', (req, res) => {
    const { minWriteIntervalMs } = req.body ?? {};
    const v = Number(minWriteIntervalMs);
    if (!Number.isFinite(v) || v < 5 || v > 100) {
      return res.status(400).json({ error: 'minWriteIntervalMs must be 5–100 (number)' });
    }
    setMinWriteIntervalMs(v);
    setItem('ble-min-write-interval-ms', String(v));
    res.json({ ok: true, minWriteIntervalMs: getMinWriteIntervalMs(), maxHz: +(1000 / v).toFixed(1) });
  });

  // --- BLE Auto-tune ---
  let _autotuneRunning = false;
  app.post('/api/ble/autotune', async (_req, res) => {
    if (_autotuneRunning) {
      return res.status(409).json({ error: 'Auto-tune already running' });
    }
    const engine = requireEngine(res);
    if (!engine) return;

    _autotuneRunning = true;
    const STEPS = [30, 25, 20, 15, 12, 10, 8, 7.5];
    const BLOCK_MS = 5000;
    const SETTLE_MS = 500;
    const originalTickMs = engine.getTickMs();
    const results: Array<{
      tickMs: number; fftDropped: number; writeFail: number;
      writeStuck: number; sent: number; passed: boolean;
    }> = [];

    console.log(`[Autotune] Start — sweep ${STEPS.length} steg, ${BLOCK_MS}ms/steg, original=${originalTickMs}ms`);

    try {
      for (const step of STEPS) {
        engine.setTickMs(step);
        engine.restartTimer();
        await new Promise(r => setTimeout(r, SETTLE_MS));
        const fftStart = bleStats.fftDroppedCount ?? 0;
        const failStart = bleStats.writeFailCount;
        const stuckStart = bleStats.writeStuckCount ?? 0;
        const sentStart = bleStats.sentCount;

        await new Promise(r => setTimeout(r, BLOCK_MS));

        const fftDelta = (bleStats.fftDroppedCount ?? 0) - fftStart;
        const failDelta = bleStats.writeFailCount - failStart;
        const stuckDelta = (bleStats.writeStuckCount ?? 0) - stuckStart;
        const sentDelta = bleStats.sentCount - sentStart;
        const passed = fftDelta === 0 && failDelta === 0 && stuckDelta === 0;

        results.push({ tickMs: step, fftDropped: fftDelta, writeFail: failDelta, writeStuck: stuckDelta, sent: sentDelta, passed });
        console.log(`[Autotune] tickMs=${step} → fftDropped=${fftDelta} writeFail=${failDelta} writeStuck=${stuckDelta} sent=${sentDelta} ${passed ? '✓' : '✗'}`);
      }

      const passing = results.filter(r => r.passed);
      const lowestSafe = passing.length > 0
        ? passing.reduce((a, b) => (b.tickMs < a.tickMs ? b : a)).tickMs
        : originalTickMs;

      engine.setTickMs(lowestSafe);
      engine.restartTimer();
      setItem('tick-ms', String(lowestSafe));

      console.log(`[Autotune] Done — vald tickMs=${lowestSafe}ms (${passing.length}/${STEPS.length} steg klarade)`);
      res.json({
        ok: true,
        chosenTickMs: lowestSafe,
        chosenMinWriteIntervalMs: Math.max(5, lowestSafe - 2),
        originalTickMs,
        results,
      });
    } catch (e: any) {
      console.error('[Autotune] Error:', e);
      try { engine.setTickMs(originalTickMs); engine.restartTimer(); } catch {}
      res.status(500).json({ error: e?.message ?? String(e) });
    } finally {
      _autotuneRunning = false;
    }
  });

  app.get('/api/ble/autotune/status', (_req, res) => {
    res.json({ running: _autotuneRunning });
  });

  // --- Microphone device ---
  app.get('/api/mic-device', (_req, res) => {
    const mic = getMic();
    res.json({ device: mic ? mic.getAlsaDevice() : (getItem('alsa-device') || 'hw:0,0') });
  });

  app.put('/api/mic-device', (req, res) => {
    const mic = requireMic(res);
    if (!mic) return;
    const { device } = req.body;
    if (typeof device === 'string' && device.length > 0) {
      mic.setAlsaDevice(device);
      setItem('alsa-device', device);
      res.json({ ok: true, device });
    } else {
      res.status(400).json({ error: 'Need device string (e.g. "hw:0,0")' });
    }
  });

  // --- Live mic level ---
  let _lastSampleTs = 0;
  let _lastSent = 0;
  let _lastSkipDelta = 0;
  let _lastSkipBusy = 0;
  let _lastSkipInFlight = 0;
  let _lastSkipRateLimit = 0;
  let _lastFftDropped = 0;
  let _lastWriteFail = 0;
  let _lastWriteStuck = 0;
  let _lastFftFrames = 0;
  let _lastTickCount = 0;
  let _lastTickOk = 0;
  let _lastTickAbortNoMic = 0;
  let _lastTickAbortNoChange = 0;
  let _lastTickAbortNoDevice = 0;

  app.get('/api/mic/level', async (_req, res) => {
    const mic = getMic();
    const engine = getEngine();
    const tickMs = engine ? engine.getTickMs() : null;
    if (!mic) {
      res.json({
        active: false, totalRms: 0, bassRms: 0, midHiRms: 0,
        backend: 'none', audioToBleLatencyMs: null, tickMs,
        ble: null,
      });
      return;
    }
    const b = mic.getLatestBands();
    let ble: any = null;
    try {
      const { bleStats } = await import('./ble/state.js');

      const now = performance.now();
      const dt = _lastSampleTs > 0 ? (now - _lastSampleTs) / 1000 : 0;
      const perSec = (cur: number, prev: number) => dt > 0 ? Math.round((cur - prev) / dt) : 0;

      const sentPerSec = perSec(bleStats.sentCount, _lastSent);
      const skipDeltaPerSec = perSec(bleStats.skipDeltaCount, _lastSkipDelta);
      const skipBusyPerSec = perSec(bleStats.skipBusyCount, _lastSkipBusy);
      const skipInFlightPerSec = perSec(bleStats.skipInFlightCount ?? 0, _lastSkipInFlight);
      const skipRateLimitPerSec = perSec(bleStats.skipRateLimitCount ?? 0, _lastSkipRateLimit);
      const fftDroppedPerSec = perSec(bleStats.fftDroppedCount ?? 0, _lastFftDropped);
      const writeFailPerSec = perSec(bleStats.writeFailCount, _lastWriteFail);
      const writeStuckPerSec = perSec(bleStats.writeStuckCount ?? 0, _lastWriteStuck);
      const tickOkPerSec = perSec(bleStats.tickOkCount ?? 0, _lastTickOk);
      const tickAbortNoMicPerSec = perSec(bleStats.tickAbortNoMicCount ?? 0, _lastTickAbortNoMic);
      const tickAbortNoChangePerSec = perSec(bleStats.tickAbortNoChangeCount ?? 0, _lastTickAbortNoChange);
      const tickAbortNoDevicePerSec = perSec(bleStats.tickAbortNoDeviceCount ?? 0, _lastTickAbortNoDevice);

      const fftFrames = mic.getFFTFrameCount?.() ?? 0;
      const tickCount = engine?.getDiagnostics().tickCount ?? 0;
      const fftPerSec = perSec(fftFrames, _lastFftFrames);
      const tickPerSec = perSec(tickCount, _lastTickCount);

      const writeLatMaxMs = bleStats.writeLatMaxMs ?? 0;
      bleStats.writeLatMaxMs = 0;

      _lastSampleTs = now;
      _lastSent = bleStats.sentCount;
      _lastSkipDelta = bleStats.skipDeltaCount;
      _lastSkipBusy = bleStats.skipBusyCount;
      _lastSkipInFlight = bleStats.skipInFlightCount ?? 0;
      _lastSkipRateLimit = bleStats.skipRateLimitCount ?? 0;
      _lastFftDropped = bleStats.fftDroppedCount ?? 0;
      _lastWriteFail = bleStats.writeFailCount;
      _lastWriteStuck = bleStats.writeStuckCount ?? 0;
      _lastFftFrames = fftFrames;
      _lastTickCount = tickCount;
      _lastTickOk = bleStats.tickOkCount ?? 0;
      _lastTickAbortNoMic = bleStats.tickAbortNoMicCount ?? 0;
      _lastTickAbortNoChange = bleStats.tickAbortNoChangeCount ?? 0;
      _lastTickAbortNoDevice = bleStats.tickAbortNoDeviceCount ?? 0;

      ble = {
        sentPerSec, skipDeltaPerSec, skipBusyPerSec, skipInFlightPerSec,
        skipRateLimitPerSec, fftDroppedPerSec, writeFailPerSec, writeStuckPerSec,
        writeLatAvgMs: bleStats.writeLatAvgMs,
        writeLatMaxMs,
        fftPerSec, tickPerSec,
        tickOkPerSec, tickAbortNoMicPerSec, tickAbortNoChangePerSec, tickAbortNoDevicePerSec,
      };
    } catch { /* protocol module not loaded yet */ }
    res.json({
      active: true,
      totalRms: b.totalRms,
      bassRms: b.bassRms,
      midHiRms: b.midHiRms,
      backend: mic.getMicBackend(),
      tickMs,
      ble,
    });
  });

  // --- Live BLE output (sista färg + brightness skickad till lampan) ---
  app.get('/api/ble/output', (_req, res) => {
    const engine = getEngine();
    if (!engine) {
      res.json({ active: false, r: 0, g: 0, b: 0, brightness: 0, sentCount: 0 });
      return;
    }
    const d = engine.getDiagnostics();
    res.json({
      active: true,
      r: d.finalR,
      g: d.finalG,
      b: d.finalB,
      brightness: d.brightnessPct,
      sentCount: bleStats.sentCount,
      skipDeltaCount: bleStats.skipDeltaCount,
      skipBusyCount: bleStats.skipBusyCount,
      writeLatAvgMs: bleStats.writeLatAvgMs,
    });
  });

  // --- Mic gain (software) ---
  app.get('/api/mic-gain', (_req, res) => {
    const mic = getMic();
    const saved = Number(getItem('mic-gain') || '15');
    res.json({ gain: mic ? mic.getMicGain() : saved });
  });

  app.put('/api/mic-gain', (req, res) => {
    const mic = requireMic(res);
    if (!mic) return;
    const { gain } = req.body;
    if (typeof gain === 'number' && gain >= 0.1 && gain <= 50) {
      mic.setMicGain(gain);
      setItem('mic-gain', String(gain));
      res.json({ ok: true, gain });
    } else {
      res.status(400).json({ error: 'gain must be 0.1-50' });
    }
   });

   // --- Auto-gain toggle ---
   app.get('/api/auto-gain', (_req, res) => {
     const mic = getMic();
     res.json({
       enabled: mic ? mic.isAutoGainEnabled() : false,
       multiplier: mic ? mic.getAutoGainMultiplier() : 1,
       effective: mic ? mic.getEffectiveGain() : Number(getItem('mic-gain') || '15'),
     });
   });
   app.put('/api/auto-gain', (req, res) => {
     const mic = requireMic(res);
     if (!mic) return;
     const { enabled } = req.body;
     if (typeof enabled === 'boolean') {
       if (enabled) mic.enableAutoGain(); else mic.disableAutoGain();
       res.json({ ok: true, enabled: mic.isAutoGainEnabled(), multiplier: mic.getAutoGainMultiplier(), effective: mic.getEffectiveGain() });
     } else {
       res.status(400).json({ error: 'enabled must be boolean' });
     }
   });

   // --- Gain calibration (two-point) ---
   app.get('/api/gain-calibration', (_req, res) => {
     const mic = getMic();
     const points = mic ? mic.getGainCalPoints() : { point1: null, point2: null };
     res.json(points);
   });

   app.put('/api/gain-calibration', (req, res) => {
     const mic = requireMic(res);
     if (!mic) return;
     const { point1, point2 } = req.body;
     mic.setGainCalPoints(point1 ?? null, point2 ?? null);
     setItem('gain-cal-points', JSON.stringify({ point1, point2 }));
     if (point1 && point2) mic.enableAutoGain();
     res.json({ ok: true, ...mic.getGainCalPoints() });
   });

   app.delete('/api/gain-calibration', (_req, res) => {
     const mic = getMic();
     mic?.setGainCalPoints(null, null);
     setItem('gain-cal-points', JSON.stringify({ point1: null, point2: null }));
     res.json({ ok: true });
   });

   // --- Dimming gamma ---
  app.get('/api/dimming-gamma', (_req, res) => {
    res.json({ gamma: getDimmingGamma() });
  });

  app.put('/api/dimming-gamma', (req, res) => {
    const { gamma } = req.body;
    if (typeof gamma === 'number' && gamma >= 1.0 && gamma <= 3.0) {
      setDimmingGamma(gamma);
      setItem('dimming-gamma', String(gamma));
      res.json({ ok: true, gamma });
    } else {
      res.status(400).json({ error: 'gamma must be 1.0-3.0' });
    }
  });

  // --- Auto TV-mode ---
  app.get('/api/auto-tv-mode', (_req, res) => {
    res.json({ enabled: getAutoTvMode() });
  });

  app.put('/api/auto-tv-mode', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') {
      setAutoTvMode(enabled);
      setItem('auto-tv-mode', enabled ? 'true' : 'false');
      res.json({ ok: true, enabled });
    } else {
      res.status(400).json({ error: 'Need enabled: boolean' });
    }
  });

  // --- Sonos gateway config ---
  const normalizeSonosGatewayConfig = (config: Partial<SonosPollerConfig> | null | undefined): SonosPollerConfig => {
    const rawBaseUrl = typeof config?.baseUrl === 'string' && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim().replace(/\/$/, '')
      : 'http://127.0.0.1:3053/api/sonos';
    const baseUrl = [
      'http://172.0.0.1:3003/api/sonos',
      'http://127.0.0.1:3003/api/sonos',
      'http://127.0.0.1:3002/api/sonos',
    ].includes(rawBaseUrl)
      ? 'http://127.0.0.1:3053/api/sonos'
      : rawBaseUrl;

    return {
      baseUrl,
      ssePath: config?.ssePath ?? '/events',
      statusPath: config?.statusPath ?? '/status',
      pollIntervalMs: config?.pollIntervalMs,
      pollTimeoutMs: config?.pollTimeoutMs,
      disableSSE: config?.disableSSE,
    };
  };

  app.get('/api/sonos-gateway/detect', async (_req, res) => {
    const CORE_PORTS = [3050, 3051, 3052, 3053];
    const probes = CORE_PORTS.map(async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return null;
        const data = await r.json();
        const name = String(data?.service ?? '').toLowerCase();
        if (!name.includes('sonos')) return null;

        const candidates = [`/api/sonos`, `/api`];
        let chosenBase: string | null = null;
        for (const suffix of candidates) {
          try {
            const probe = await fetch(`http://127.0.0.1:${port}${suffix}/status`, { signal: AbortSignal.timeout(1000) });
            if (probe.ok) { chosenBase = suffix; break; }
          } catch {}
        }
        if (!chosenBase) return null;

        return {
          port,
          url: `http://127.0.0.1:${port}${chosenBase}`,
          name: data.service,
          version: data.version ?? null,
          core: port - 3050,
        };
      } catch { return null; }
    });
    const results = (await Promise.all(probes)).filter(Boolean);
    if (results.length > 0) {
      const best = results[0]!;
      res.json({ found: true, url: best.url, name: best.name, version: best.version, core: best.core });
    } else {
      res.json({ found: false });
    }
  });

  app.get('/api/sonos-gateway', (_req, res) => {
    const savedRaw = getItem('sonos-gateway');
    let saved: SonosPollerConfig | null = null;
    if (savedRaw) {
      try {
        saved = normalizeSonosGatewayConfig(JSON.parse(savedRaw));
        if (savedRaw !== JSON.stringify(saved)) setItem('sonos-gateway', JSON.stringify(saved));
      } catch {}
    }

    const current = getPollerConfig();
    res.json({
      saved,
      active: current ? normalizeSonosGatewayConfig(current) : null,
    });
  });

  app.put('/api/sonos-gateway', (req, res) => {
    const config = normalizeSonosGatewayConfig(req.body);
    if (!config.baseUrl) {
      return res.status(400).json({ error: 'Need baseUrl' });
    }
    setItem('sonos-gateway', JSON.stringify(config));
    stopSonosPoller();
    startSonosPoller(config).catch((e: any) => console.warn('[Sonos] Restart failed:', e.message));
    res.json({ ok: true, config });
  });

  // --- BLE Fade Test ---
  let fadeRunning = false;
  let fadeCurrentWps = 0;
  let fadeAbort = false;

  app.post('/api/ble-fade-test', async (_req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    if (fadeRunning) {
      return res.status(409).json({ error: 'Test already running' });
    }
    fadeRunning = true;
    fadeAbort = false;
    fadeCurrentWps = 0;
    engine.suspend();
    res.json({ ok: true, message: 'Fade test started' });

    const steps = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
    const fadeSteps = 50;
    const cyclesPerStep = 2;

    for (const wps of steps) {
      if (fadeAbort) break;
      fadeCurrentWps = wps;
      const intervalMs = Math.round(1000 / wps);

      for (let cycle = 0; cycle < cyclesPerStep && !fadeAbort; cycle++) {
        for (let i = 0; i <= fadeSteps && !fadeAbort; i++) {
          const v = Math.round((i / fadeSteps) * 255);
          sendRawColor(v, 0, 0);
          await new Promise(r => setTimeout(r, intervalMs));
        }
        for (let i = fadeSteps; i >= 0 && !fadeAbort; i--) {
          const v = Math.round((i / fadeSteps) * 255);
          sendRawColor(v, 0, 0);
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      if (!fadeAbort) await new Promise(r => setTimeout(r, 400));
    }

    fadeRunning = false;
    engine.resume();
  });

  app.get('/api/ble-fade-test/status', (_req, res) => {
    res.json({ running: fadeRunning, currentWps: fadeCurrentWps });
  });

  app.post('/api/ble-fade-test/stop', (_req, res) => {
    const lastWps = fadeCurrentWps;
    fadeAbort = true;
    sendRawColor(0, 0, 0);
    fadeRunning = false;
    getEngine()?.resume();
    res.json({ ok: true, lastWps });
  });

  // --- Software Update ---
  let updateRunning = false;
  let updateLog = '';

  app.get('/api/update/check', async (_req, res) => {
    try {
      const { readFileSync } = await import('fs');
      let currentCommit = '';
      try {
        const vf = JSON.parse(readFileSync('/opt/lotus-light/VERSION.json', 'utf8'));
        currentCommit = vf.commit ?? '';
      } catch {}

      const r = await fetch('https://api.github.com/repos/raagerrd-ship-it/lotus-light-link/releases', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return res.json({ error: 'GitHub API error' });
      const releases = await r.json();
      const data = (releases as any[]).find((rel: any) => /^v\d+\.\d+\.\d+$/.test(rel.tag_name ?? '') && !rel.draft && !rel.prerelease);
      if (!data) return res.json({ error: 'No valid semver release found' });
      const latestVersion = data.tag_name?.replace(/^v/, '') ?? '';
      const latestCommitRaw = data.target_commitish ?? '';
      const latestCommit = /^[0-9a-f]{7,40}$/i.test(latestCommitRaw) ? latestCommitRaw : '';
      const upToDate = SERVICE_VERSION === latestVersion;

      res.json({
        upToDate,
        currentCommit: currentCommit.substring(0, 7),
        latestCommit: latestCommit.substring(0, 7),
        releaseName: data.name ?? data.tag_name ?? '',
        currentVersion: SERVICE_VERSION,
        latestVersion,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/update/run', async (_req, res) => {
    if (updateRunning) return res.status(409).json({ error: 'Update already running' });
    updateRunning = true;
    updateLog = '';
    res.json({ ok: true, message: 'Update started — process will exit after install' });

    const { exec } = await import('child_process');
    exec('bash /opt/lotus-light/pi/update-services.sh 2>&1', { timeout: 120000 }, (err, stdout, stderr) => {
      updateLog = stdout + (stderr || '') + (err ? `\nError: ${err.message}` : '');
      updateRunning = false;
      console.log('[Update]', updateLog);
      if (err) {
        console.error('[Update] Skript misslyckades — INTE exit:', err.message);
        return;
      }
      console.log('[Update] ✓ Klart — exit(0) om 1s');
      setTimeout(() => process.exit(0), 1000);
    });
  });

  app.get('/api/update/status', (_req, res) => {
    res.json({ running: updateRunning, log: updateLog });
  });

  app.post('/api/update/force', async (_req, res) => {
    if (updateRunning) return res.status(409).json({ error: 'Update already running' });
    updateRunning = true;
    updateLog = '';
    res.json({ ok: true, message: 'Force update started — process will exit after install' });

    const { exec } = await import('child_process');
    const cmds = [
      'sudo rm -f /opt/lotus-light/VERSION.json',
      'bash /opt/lotus-light/pi/update-services.sh 2>&1',
    ].join(' && ');
    exec(cmds, { timeout: 180000 }, (err, stdout, stderr) => {
      updateLog = stdout + (stderr || '') + (err ? `\nError: ${err.message}` : '');
      updateRunning = false;
      console.log('[Force Update]', updateLog);
      if (err) {
        console.error('[Force Update] Skript misslyckades — INTE exit, behåller gamla processen:', err.message);
        return;
      }
      console.log('[Force Update] ✓ Klart — exit(0) om 1s så systemd startar oss på ny kod');
      setTimeout(() => {
        console.log('[Force Update] 👋 process.exit(0) — systemd Restart=always tar över');
        process.exit(0);
      }, 1000);
    });
  });

  app.get('/api/diagnostics', (_req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const mic = getMic();
    const diag = engine.getDiagnostics();
    const cal = engine.getCalibration();
    res.json({
      pipeline: diag,
      ble: bleStats,
      calibration: {
        dimmingGamma: getDimmingGamma(),
        releaseAlpha: cal.releaseAlpha,
        dynamicDamping: cal.dynamicDamping,
        brightnessFloor: cal.brightnessFloor,
        perceptualCurve: cal.perceptualCurve,
        transientBoost: cal.transientBoost,
      },
      micGain: {
        base: mic ? mic.getMicGain() : Number(getItem('mic-gain') || '15'),
        autoGainEnabled: mic ? mic.isAutoGainEnabled() : false,
        autoMultiplier: mic ? mic.getAutoGainMultiplier() : 1,
        effective: mic ? mic.getEffectiveGain() : Number(getItem('mic-gain') || '15'),
      },
      build: { bleTag: BLE_BUILD_TAG },
    });
  });

  // API-only mode — frontend is served by a separate process
  app.get('/', (_req, res) => {
    res.redirect('/api/status');
  });

  app.listen(port, () => {
    console.log(`[Config] Server listening on :${port}`);
  });
}
