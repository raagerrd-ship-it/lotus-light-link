/**
 * Config server — Express API for mobile configuration.
 * API-only — the web UI is served by a separate frontend process.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames, setDimmingGamma, getDimmingGamma, sendRawColor, scanForDevices, selectDevice, forgetDevice, getLastScanResults, getSavedDeviceId, getSavedDeviceName, getConnectedDeviceId, isScanning, isDemandActive, requestConnect } from './nobleBle.js';
import { getAlsaDevice, setAlsaDevice, getMicGain, setMicGain, getEffectiveGain, getAutoGainMultiplier, disableAutoGain, enableAutoGain, isAutoGainEnabled, getGainCalPoints, setGainCalPoints, type GainCalPoint } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';

// Version info — resolved once at startup
let SERVICE_VERSION = '1.0.0';
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';

// 1. Try VERSION.json (from release tarball — no git needed)
try {
  const vf = JSON.parse(readFileSync('/opt/lotus-light/VERSION.json', 'utf8'));
  SERVICE_VERSION = vf.version ?? SERVICE_VERSION;
  GIT_COMMIT = vf.commit ?? GIT_COMMIT;
  GIT_COMMIT_SHORT = vf.commitShort ?? GIT_COMMIT_SHORT;
  GIT_BRANCH = vf.branch ?? GIT_BRANCH;
} catch {
  // 2. Fallback: read from git (dev / git-clone installs)
  try {
    GIT_COMMIT = execSync('git rev-parse HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
    GIT_COMMIT_SHORT = GIT_COMMIT.substring(0, 7);
    GIT_BRANCH = execSync('git rev-parse --abbrev-ref HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
    try {
      const tag = execSync('git describe --tags --abbrev=0 2>/dev/null', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
      if (tag) SERVICE_VERSION = tag.replace(/^v/, '');
    } catch { /* no tags */ }
  } catch { /* not a git repo */ }
}

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
        savedDeviceName: getSavedDeviceName(),
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

  // --- Raw mode (for gain calibration) ---
  app.put('/api/raw-mode', (req, res) => {
    const on = !!req.body.enabled;
    engine.setRawMode(on);
    res.json({ ok: true, rawMode: on });
  });

  app.get('/api/raw-mode', (_req, res) => {
    res.json({ enabled: engine.isRawMode() });
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
    if (typeof tickMs === 'number' && tickMs >= 10 && tickMs <= 50) {
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

  // --- Mic gain (software) ---
  app.get('/api/mic-gain', (_req, res) => {
    res.json({ gain: getMicGain() });
  });

  app.put('/api/mic-gain', (req, res) => {
    const { gain } = req.body;
    if (typeof gain === 'number' && gain >= 0.1 && gain <= 50) {
      setMicGain(gain);
      setItem('mic-gain', String(gain));
      res.json({ ok: true, gain });
    } else {
      res.status(400).json({ error: 'gain must be 0.1-50' });
    }
   });
 
   // --- Auto-gain toggle ---
   app.get('/api/auto-gain', (_req, res) => {
     res.json({ enabled: isAutoGainEnabled(), multiplier: getAutoGainMultiplier(), effective: getEffectiveGain() });
   });
   app.put('/api/auto-gain', (req, res) => {
     const { enabled } = req.body;
     if (typeof enabled === 'boolean') {
       if (enabled) enableAutoGain(); else disableAutoGain();
       res.json({ ok: true, enabled: isAutoGainEnabled(), multiplier: getAutoGainMultiplier(), effective: getEffectiveGain() });
     } else {
       res.status(400).json({ error: 'enabled must be boolean' });
     }
   });

   // --- Gain calibration (two-point) ---
   // Load saved calibration at startup
   try {
     const saved = getItem('gain-cal-points');
     if (saved) {
       const { point1, point2 } = JSON.parse(saved);
       setGainCalPoints(point1 ?? null, point2 ?? null);
     }
   } catch {}

   app.get('/api/gain-calibration', (_req, res) => {
     const { point1, point2 } = getGainCalPoints();
     res.json({ point1, point2 });
   });

   app.put('/api/gain-calibration', (req, res) => {
     const { point1, point2 } = req.body;
     setGainCalPoints(point1 ?? null, point2 ?? null);
     setItem('gain-cal-points', JSON.stringify({ point1, point2 }));
     // Auto-enable auto-gain when calibration is set
     if (point1 && point2) enableAutoGain();
     res.json({ ok: true, ...getGainCalPoints() });
   });

   app.delete('/api/gain-calibration', (_req, res) => {
     setGainCalPoints(null, null);
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
    engine.suspend(); // Pause engine so mic doesn't interfere
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
    engine.resume(); // Resume engine after test
  });

  app.get('/api/ble-fade-test/status', (_req, res) => {
    res.json({ running: fadeRunning, currentWps: fadeCurrentWps });
  });

  app.post('/api/ble-fade-test/stop', (_req, res) => {
    const lastWps = fadeCurrentWps;
    fadeAbort = true;
    // Turn off after stop
    sendRawColor(0, 0, 0);
    fadeRunning = false;
    engine.resume(); // Resume engine on manual stop
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

      const r = await fetch('https://api.github.com/repos/raagerrd-ship-it/lotus-light-link/releases/tags/latest', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return res.json({ error: 'GitHub API error' });
      const data = await r.json();
      const latestCommit = data.target_commitish ?? '';
      const upToDate = currentCommit === latestCommit;

      res.json({
        upToDate,
        currentCommit: currentCommit.substring(0, 7),
        latestCommit: latestCommit.substring(0, 7),
        releaseName: data.name ?? '',
        currentVersion: SERVICE_VERSION,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/update/run', async (_req, res) => {
    if (updateRunning) return res.status(409).json({ error: 'Update already running' });
    updateRunning = true;
    updateLog = '';
    res.json({ ok: true, message: 'Update started' });

    // Run update script in background
    const { exec } = await import('child_process');
    exec('bash /opt/lotus-light/pi/update-services.sh 2>&1', { timeout: 120000 }, (err, stdout, stderr) => {
      updateLog = stdout + (stderr || '') + (err ? `\nError: ${err.message}` : '');
      updateRunning = false;
      console.log('[Update]', updateLog);
    });
  });

  app.get('/api/update/status', (_req, res) => {
    res.json({ running: updateRunning, log: updateLog });
  });

  // --- Diagnostics recording ---
  app.post('/api/diagnostics/record', async (req, res) => {
    if (engine.isRecording()) {
      return res.status(409).json({ error: 'Recording already in progress' });
    }
    const durationMs = typeof req.body?.durationMs === 'number' ? Math.min(10000, Math.max(1000, req.body.durationMs)) : 5000;
    res.json({ ok: true, durationMs });
    // Record runs in background; client polls /api/diagnostics/recording
    engine.startRecording(durationMs).then(data => {
      // Store last recording for retrieval
      (engine as any)._lastRecordingData = data;
    });
  });

  app.get('/api/diagnostics/recording', (_req, res) => {
    if (engine.isRecording()) {
      return res.json({ status: 'recording' });
    }
    const data = (engine as any)._lastRecordingData;
    if (data) {
      res.json({ status: 'done', samples: data });
    } else {
      res.json({ status: 'idle' });
    }
  });

  // --- Diagnostics ---
  app.get('/api/diagnostics', (_req, res) => {
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
        base: getMicGain(),
        autoGainEnabled: isAutoGainEnabled(),
        autoMultiplier: getAutoGainMultiplier(),
        effective: getEffectiveGain(),
      },
      ranges: {
        rawRms:        { ok: [0.01, 0.5],  warn: '0 = ingen signal' },
        bassRms:       { ok: [0.01, 0.3],  warn: '0 = ingen bas' },
        midHiRms:      { ok: [0.01, 0.2],  warn: '0 = inget diskant' },
        peakMax:       { ok: [0.005, 1.0], warn: '<0.005 = tyst rum' },
        agcQuietTicks: { ok: [0, 50],      warn: '>50 = tyst länge' },
        bassNorm:      { ok: [0.1, 0.9],   warn: '>0.95 = AGC peak för nära' },
        midHiNorm:     { ok: [0.1, 0.9],   warn: '>0.95 = AGC peak för nära' },
        preDynamics:   { ok: [0.2, 0.8],   warn: '>0.9 = redan mättad före expansion' },
        energyNorm:    { ok: [0.2, 0.8],   warn: '<0.1 = för tyst, >0.95 = clipping' },
        dynamicCenter: { ok: [0.3, 0.7],   warn: 'fast vid 0 eller 1 = problem' },
        onsetBoost:    { ok: [0, 0.22],    warn: '>0.22 bör ej hända' },
        brightnessPct: { ok: [30, 100],    warn: '<20 = svagt ljus' },
        bleScaleRaw:   { ok: [0.1, 1.0],   warn: '<0.05 = näst osynligt' },
        bleWriteLatMs: { ok: [0, 15],      warn: '>20 = för långsam BLE' },
        bleSkipBusy:   { ok: [0, 50],      warn: '>200 = BLE halkar efter' },
        lastTickUs:    { ok: [0, 500],     warn: '>1000 = motorn är överbelastad' },
      },
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
