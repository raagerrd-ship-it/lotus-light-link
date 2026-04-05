/**
 * Config server — Express on :3001 for mobile configuration.
 * Exposes calibration, color, preset, status endpoints.
 */

import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames } from './nobleBle.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, type SonosPollerConfig } from './sonosPoller.js';

export function startConfigServer(engine: PiLightEngine, port = 3001): void {
  const app = express();
  app.use(express.json());

  // CORS for mobile access
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT');
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
      // Restart timer with new interval
      engine.stop();
      engine.start();
      res.json({ ok: true, tickMs });
    } else {
      res.status(400).json({ error: 'tickMs must be 20-200' });
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
