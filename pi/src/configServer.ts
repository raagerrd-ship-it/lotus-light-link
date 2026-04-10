/**
 * Config server — Express on :3001 for mobile configuration.
 * Exposes calibration, color, preset, status endpoints.
 */

import { execSync } from 'child_process';
import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames, setDimmingGamma, getDimmingGamma, sendRawColor, scanForDevices, selectDevice, forgetDevice, getLastScanResults, getSavedDeviceId, getConnectedDeviceId, isScanning, isDemandActive, requestConnect } from './nobleBle.js';
import { getAlsaDevice, setAlsaDevice } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';

// Git info — resolved once at startup
const SERVICE_VERSION = '1.0.0';
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
try {
  GIT_COMMIT = execSync('git rev-parse HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
  GIT_COMMIT_SHORT = GIT_COMMIT.substring(0, 7);
  GIT_BRANCH = execSync('git rev-parse --abbrev-ref HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
} catch { /* not a git repo or git not available */ }

export function startConfigServer(engine: PiLightEngine, port = 3001): void {

  const app = express();
  app.use(express.json());

  // CORS for mobile access
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // --- Status ---
  app.get('/api/status', (_req, res) => {
    const sonos = getSonosState();
    res.json({
      ok: true,
      ble: {
        connected: getConnectedCount(),
        devices: getConnectedNames(),
        stats: bleStats,
        savedDeviceId: getSavedDeviceId(),
        connectedDeviceId: getConnectedDeviceId(),
        scanning: isScanning(),
        demand: isDemandActive(),
      },
      commit: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
      version: SERVICE_VERSION,
      sonos,
      engine: {
        running: true,
        tickMs: engine.getTickMs(),
        hz: Math.round(1000 / engine.getTickMs()),
        palette: engine.getPalette(),
      },
    });
  });

  // --- Version ---
  app.get('/api/version', (_req, res) => {
    res.json({
      name: 'lotus-light-link',
      version: SERVICE_VERSION,
      commit: GIT_COMMIT,
      commitShort: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
    });
  });

  // --- BLE Device Management ---
  app.post('/api/ble/scan', async (_req, res) => {
    if (isScanning()) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    const devices = await scanForDevices(10000);
    res.json({ ok: true, devices });
  });

  app.get('/api/ble/devices', (_req, res) => {
    res.json({
      devices: getLastScanResults(),
      savedDeviceId: getSavedDeviceId(),
      connectedDeviceId: getConnectedDeviceId(),
      scanning: isScanning(),
    });
  });

  app.post('/api/ble/select', async (req, res) => {
    const { deviceId } = req.body;
    if (typeof deviceId !== 'string') {
      return res.status(400).json({ error: 'Need deviceId' });
    }
    const ok = await selectDevice(deviceId);
    if (!ok) return res.json({ ok: false });

    // Preview: run engine tick loop for 10s (sends idle color naturally), then stop + disconnect
    engine.setPlaying(true);
    setTimeout(() => {
      engine.setPlaying(false);
      import('./nobleBle.js').then(m => m.disconnect());
      console.log('[BLE] Preview done, disconnected (saved for later)');
    }, 10000);

    res.json({ ok: true, previewSeconds: 10 });
  });

  app.post('/api/ble/forget', async (_req, res) => {
    await forgetDevice();
    res.json({ ok: true });
  });

  // --- Calibration ---
  app.get('/api/calibration', (_req, res) => {
    const raw = getItem('light-calibration');
    res.json(raw ? JSON.parse(raw) : {});
  });

  app.put('/api/calibration', (req, res) => {
    const current = getItem('light-calibration');
    const merged = { ...(current ? JSON.parse(current) : {}), ...req.body };
    setItem('light-calibration', JSON.stringify(merged));
    engine.reloadCalibration();
    res.json({ ok: true });
  });

  // --- Color ---
  app.put('/api/color', (req, res) => {
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
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Need color: [r,g,b]' });
    }
  });

  // --- Tick rate ---
  app.put('/api/tick-ms', (req, res) => {
    const { tickMs } = req.body;
    if (typeof tickMs === 'number' && tickMs >= 20 && tickMs <= 200) {
      engine.setTickMs(tickMs);
      engine.restartTimer();
      setItem('tick-ms', String(tickMs));
      res.json({ ok: true, tickMs });
    } else {
      res.status(400).json({ error: 'tickMs must be 20-200' });
    }
  });



  // --- Microphone device ---
  app.get('/api/mic-device', (_req, res) => {
    res.json({ device: getAlsaDevice() });
  });

  app.put('/api/mic-device', (req, res) => {
    const { device } = req.body;
    if (typeof device === 'string' && device.length > 0) {
      setAlsaDevice(device);
      setItem('alsa-device', device);
      res.json({ ok: true, device });
    } else {
      res.status(400).json({ error: 'Need device string (e.g. "plughw:0,0")' });
    }
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
  app.get('/api/sonos-gateway', (_req, res) => {
    const saved = getItem('sonos-gateway');
    const current = getPollerConfig();
    res.json({
      saved: saved ? JSON.parse(saved) : null,
      active: current,
    });
  });

  app.put('/api/sonos-gateway', async (req, res) => {
    const config: SonosPollerConfig = req.body;
    if (!config?.baseUrl) {
      return res.status(400).json({ error: 'Need baseUrl' });
    }
    // Persist and restart poller
    setItem('sonos-gateway', JSON.stringify(config));
    stopSonosPoller();
    await startSonosPoller(config);
    res.json({ ok: true, config });
  });

  // --- BLE Fade Test ---
  let fadeRunning = false;
  let fadeCurrentWps = 0;
  let fadeAbort = false;

  app.post('/api/ble-fade-test', async (_req, res) => {
    if (fadeRunning) {
      return res.status(409).json({ error: 'Test already running' });
    }
    fadeRunning = true;
    fadeAbort = false;
    fadeCurrentWps = 0;
    res.json({ ok: true, message: 'Fade test started' });

    // Run fade sequence in background
    const steps = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
    const fadeSteps = 50; // 0→255→0 in this many writes per cycle
    const cyclesPerStep = 2;

    for (const wps of steps) {
      if (fadeAbort) break;
      fadeCurrentWps = wps;
      const intervalMs = Math.round(1000 / wps);

      for (let cycle = 0; cycle < cyclesPerStep && !fadeAbort; cycle++) {
        // Up: 0 → 255
        for (let i = 0; i <= fadeSteps && !fadeAbort; i++) {
          const v = Math.round((i / fadeSteps) * 255);
          sendRawColor(v, 0, 0);
          await new Promise(r => setTimeout(r, intervalMs));
        }
        // Down: 255 → 0
        for (let i = fadeSteps; i >= 0 && !fadeAbort; i--) {
          const v = Math.round((i / fadeSteps) * 255);
          sendRawColor(v, 0, 0);
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      // Brief pause between steps
      if (!fadeAbort) await new Promise(r => setTimeout(r, 400));
    }

    fadeRunning = false;
  });

  app.get('/api/ble-fade-test/status', (_req, res) => {
    res.json({ running: fadeRunning, currentWps: fadeCurrentWps });
  });

  app.post('/api/ble-fade-test/stop', (_req, res) => {
    const lastWps = fadeCurrentWps;
    fadeAbort = true;
    // Turn off after stop
    sendRawColor(0, 0, 0);
    res.json({ ok: true, lastWps });
  });

  // API-only mode — frontend is served by a separate process
  app.get('/', (_req, res) => {
    res.redirect('/api/status');
  });

  app.listen(port, () => {
    console.log(`[Config] Server listening on :${port}`);
  });
}
