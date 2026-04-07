/**
 * Config server — Express on :3001 for mobile configuration.
 * Exposes calibration, color, preset, status endpoints.
 */

import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames, setDimmingGamma, getDimmingGamma } from './nobleBle.js';
import { getAlsaDevice, setAlsaDevice } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';

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
      },
      sonos,
      engine: {
        running: true,
        tickMs: engine.getTickMs(),
      },
    });
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

  app.listen(port, () => {
    console.log(`[Config] Server listening on :${port}`);
  });
}
