/**
 * Config server — Express API for mobile configuration.
 * API-only — the web UI is served by a separate frontend process.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames, setDimmingGamma, getDimmingGamma, sendRawColor, scanForDevices, selectDevice, forgetDevice, saveManualDevice, getLastScanResults, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, getSavedAddressType, getSavedConnectable, getSavedServiceUuids, getConnectedDeviceId, isScanning, isDemandActive, requestConnect, releaseDemand, getAdapterState, getConnectionLog, processHasBtCaps, BLE_BUILD_TAG, noble, isConnectInProgress, resetHciAdapter, disconnect, workaroundCounters, isBleEnabled, setBleEnabled, ensureAdapterUp } from './nobleBle.js';
import { bumpWorkaround } from './ble/state.js';
import { getAlsaDevice, setAlsaDevice, getMicGain, setMicGain, getEffectiveGain, getAutoGainMultiplier, disableAutoGain, enableAutoGain, isAutoGainEnabled, getGainCalPoints, setGainCalPoints, type GainCalPoint } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { invalidateIdleColorCache } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, type SonosPollerConfig } from './sonosPoller.js';

// Version info — refresh on demand so UI reflects the latest deployed release
let SERVICE_VERSION = '1.0.0';
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
const START_TIME = Date.now();

function refreshVersionInfo(): void {
  // Try multiple paths for VERSION.json
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
        return;
      }
    } catch {
      // try next path
    }
  }

  // Fallback: git (dev only)
  try {
    GIT_COMMIT = execSync('git rev-parse HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
    GIT_COMMIT_SHORT = GIT_COMMIT.substring(0, 7);
    GIT_BRANCH = execSync('git rev-parse --abbrev-ref HEAD', { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
    try {
      const tag = execSync("git tag -l --sort=-v:refname | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | head -n1", { cwd: '/opt/lotus-light', encoding: 'utf8', timeout: 3000 }).trim();
      if (tag) SERVICE_VERSION = tag.replace(/^v/, '');
    } catch {}
  } catch {}

  console.warn(`[Config] VERSION.json not found at any path, using fallback v${SERVICE_VERSION}/${GIT_COMMIT_SHORT}`);
}

refreshVersionInfo();

export function startConfigServer(engine: PiLightEngine, port = 3050): void {

  const app = express();
  app.use(express.json());

  // CORS for mobile access
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // --- Health (Pi Control Center standard) ---
  app.get('/api/health', (_req, res) => {
    refreshVersionInfo();
    const mem = process.memoryUsage();
    const bleConnected = getConnectedCount();
    const rss = Math.round(mem.rss / 1024 / 1024);
    const adapterState = getAdapterState() ?? 'unknown';

    // Check if BLE has the capabilities it needs (poweredOn = caps are OK)
    const hasCapabilities = adapterState !== 'unauthorized';

    let status: 'ok' | 'degraded' | 'error' = 'ok';
    if (rss > 100) status = 'degraded';
    if (bleConnected === 0 && isDemandActive()) status = 'degraded';
    if (adapterState === 'unauthorized') status = 'error';

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
        adapterState,
        hasCapabilities,
        connected: bleConnected,
        savedDevice: getSavedDeviceName(),
        demand: isDemandActive(),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // --- Status (full app status) ---
  app.get('/api/status', (_req, res) => {
    refreshVersionInfo();
    const sonos = getSonosState();
    res.json({
      ok: true,
      ble: {
        connected: getConnectedCount(),
        devices: getConnectedNames(),
        adapterState: getAdapterState() ?? 'unknown',
        stats: bleStats,
        savedDeviceId: getSavedDeviceId(),
        savedDeviceName: getSavedDeviceName(),
        savedDeviceAddress: getSavedDeviceAddress(),
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
    refreshVersionInfo();
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
    try {
      const devices = await scanForDevices(10000);
      res.json({ ok: true, devices, adapterState: getAdapterState() });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'BLE scan failed', adapterState: getAdapterState() });
    }
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
    try {
      const ok = await selectDevice(deviceId);
      if (!ok) return res.json({ ok: false, error: 'Connection failed — noble could not find or connect to device' });
    } catch (e: any) {
      console.error(`[BLE] selectDevice error: ${e.message}`);
      return res.json({ ok: false, error: e.message });
    }

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

  // Manually save a device by MAC address (skips scan).
  // Body: { address: "BE:67:00:15:09:41", name: "ELK-BLEDOM01" }
  app.post('/api/ble/save-manual', async (req, res) => {
    const { address, name } = req.body ?? {};
    if (typeof address !== 'string' || !address.trim()) {
      return res.status(400).json({ error: 'Need MAC address (e.g. BE:67:00:15:09:41)' });
    }
    if (typeof name !== 'string' || name.trim().length > 64) {
      return res.status(400).json({ error: 'Name must be a string (max 64 chars)' });
    }
    try {
      const ok = await saveManualDevice(address, name);
      if (!ok) return res.status(400).json({ error: 'Invalid MAC address format' });
      res.json({
        ok: true,
        savedDeviceId: getSavedDeviceId(),
        savedDeviceName: getSavedDeviceName(),
        savedDeviceAddress: getSavedDeviceAddress(),
        connected: !!getConnectedDeviceId(),
      });
    } catch (e: any) {
      console.error(`[BLE] saveManualDevice error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Manual connect — force BLE connection even without music playing
  app.post('/api/ble/connect', async (_req, res) => {
    if (!getSavedDeviceId()) return res.status(400).json({ error: 'No saved device' });
    if (getConnectedDeviceId()) return res.json({ ok: true, message: 'Already connected' });
    try {
      await requestConnect();
      res.json({ ok: true, message: 'Connect requested' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual HCI/noble reset — only used as recovery if noble wedges.
  // In normal operation noble owns the HCI socket from boot to shutdown.
  app.post('/api/ble/reset', async (_req, res) => {
    bumpWorkaround('manualBleReset_invoked');
    try {
      await disconnect(true); // disconnect + release HCI
      res.json({ ok: true, message: 'BLE-stacken återställd. Anslut igen vid behov.' });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'reset failed' });
    }
  });

  // ── BLE master switch ──
  // Default OFF after every boot. Frontend toggle calls these.
  app.post('/api/ble/start', async (_req, res) => {
    setBleEnabled(true);
    let connectStarted = false;
    if (getSavedDeviceId() && !getConnectedDeviceId()) {
      // Fire and forget — UI polls /api/ble/diagnostics for status updates.
      requestConnect().catch(e => console.error('[BLE] start auto-connect failed:', e?.message ?? e));
      connectStarted = true;
    }
    res.json({ ok: true, enabled: true, autoConnect: connectStarted });
  });

  app.post('/api/ble/stop', async (_req, res) => {
    setBleEnabled(false);
    releaseDemand();
    try {
      await disconnect(true); // disconnect device + release HCI socket
      res.json({ ok: true, enabled: false, message: 'BLE av — adapter frisläppt' });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'stop failed' });
    }
  });

  app.get('/api/ble/state', (_req, res) => {
    res.json({
      enabled: isBleEnabled(),
      connected: getConnectedCount() > 0,
      connectedDeviceId: getConnectedDeviceId(),
      savedDeviceId: getSavedDeviceId(),
      demand: isDemandActive(),
    });
  });

  // BLE connection diagnostics log
  app.get('/api/ble/log', (_req, res) => {
    res.json({ events: getConnectionLog() });
  });

  // BLE saved device metadata (for verifying direct-connect data)
  app.get('/api/ble/saved-metadata', (_req, res) => {
    res.json({
      id: getSavedDeviceId(),
      name: getSavedDeviceName(),
      address: getSavedDeviceAddress(),
      addressType: getSavedAddressType(),
      connectable: getSavedConnectable(),
      serviceUuids: getSavedServiceUuids(),
      directConnectReady: !!(getSavedAddressType() && getSavedDeviceAddress()),
    });
  });
  app.get('/api/ble/diagnostics', (_req, res) => {
    const adapterState = getAdapterState() ?? 'unknown';
    const hasCaps = processHasBtCaps();
    const events = getConnectionLog();

    // Raw noble internals (before any caps-aware override) — for OS↔noble comparison
    const n = noble as any;
    const nobleRaw = {
      state: n?.state ?? null,
      _state: n?._state ?? null,
      adapterState: n?.adapterState ?? null,
      _adapterState: n?._adapterState ?? null,
    };

    // Raw HCI adapter info from the OS (hciconfig hci0)
    let hciRaw = '';
    let hciError: string | null = null;
    try {
      hciRaw = execSync('hciconfig hci0 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (e: any) {
      hciError = e?.message ?? 'hciconfig failed';
    }
    let rfkill = '';
    try {
      rfkill = execSync('rfkill list bluetooth 2>&1', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch {}

    res.json({
      adapter: {
        state: adapterState,
        hasCaps,
        nobleRaw,
        hci: { raw: hciRaw, error: hciError },
        rfkill,
      },
      build: {
        bleTag: BLE_BUILD_TAG,
      },
      enabled: isBleEnabled(),
      workarounds: workaroundCounters,
      stats: {
        connected: getConnectedCount(),
        savedDevice: getSavedDeviceName(),
        savedDeviceId: getSavedDeviceId(),
        connectedDeviceId: getConnectedDeviceId(),
        demand: isDemandActive(),
        scanning: isScanning(),
        sentCount: bleStats.sentCount,
        writeFailCount: bleStats.writeFailCount,
        disconnectCount: bleStats.disconnectCount,
        reconnectCount: bleStats.reconnectCount,
        lastDisconnectReason: bleStats.lastDisconnectReason,
        lastDisconnectAt: bleStats.lastDisconnectAt,
      },
      events,
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
      invalidateIdleColorCache(); // clear cache so next heartbeat picks up new color
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
      res.status(400).json({ error: 'tickMs must be 10-50' });
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

  // Detect Sonos gateway on any PCC core (port 3050–3052 = engine ports for core 0–2)
  app.get('/api/sonos-gateway/detect', async (_req, res) => {
    const CORE_PORTS = [3050, 3051, 3052];
    const probes = CORE_PORTS.map(async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return null;
        const data = await r.json();
        // Check if this service has a Sonos-related endpoint (sonos status in health or service name)
        const name = data?.service ?? '';
        const isSonosGateway = name.includes('sonos') || name.includes('cast-away') || name.includes('buddy');
        if (!isSonosGateway) return null;
        return { port, url: `http://127.0.0.1:${port}/api/sonos`, name: data.service, version: data.version ?? null, core: port - 3050 };
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
    // Persist and restart poller (non-blocking — don't await)
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
    res.json({ ok: true, message: 'Update started' });

    // Run update script in background
    const { exec } = await import('child_process');
    exec('bash /opt/lotus-light/pi/update-services.sh 2>&1', { timeout: 120000 }, (err, stdout, stderr) => {
      updateLog = stdout + (stderr || '') + (err ? `\nError: ${err.message}` : '');
      updateRunning = false;
      console.log('[Update]', updateLog);
      if (!err) {
        console.log('[Update] Restarting service...');
        exec('systemctl --user restart lotus-light-engine', { timeout: 10000 }, (restartErr) => {
          if (restartErr) console.error('[Update] Restart failed:', restartErr.message);
          else console.log('[Update] Service restarted ✓');
        });
      }
    });
  });

  app.get('/api/update/status', (_req, res) => {
    res.json({ running: updateRunning, log: updateLog });
  });

  // Force update — skip version check, clear caches, redownload
  app.post('/api/update/force', async (_req, res) => {
    if (updateRunning) return res.status(409).json({ error: 'Update already running' });
    updateRunning = true;
    updateLog = '';
    res.json({ ok: true, message: 'Force update started' });

    const { exec } = await import('child_process');
    // Delete VERSION.json so update-services.sh won't skip due to "already up to date"
    const cmds = [
      'rm -f /opt/lotus-light/VERSION.json',
      'bash /opt/lotus-light/pi/update-services.sh 2>&1',
    ].join(' && ');
    exec(cmds, { timeout: 180000 }, (err, stdout, stderr) => {
      updateLog = stdout + (stderr || '') + (err ? `\nError: ${err.message}` : '');
      updateRunning = false;
      console.log('[Force Update]', updateLog);
      // Auto-restart service after successful update
      if (!err) {
        console.log('[Force Update] Restarting service...');
        exec('systemctl --user restart lotus-light-engine', { timeout: 10000 }, (restartErr) => {
          if (restartErr) console.error('[Force Update] Restart failed:', restartErr.message);
          else console.log('[Force Update] Service restarted ✓');
        });
      }
    });
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

  // --- Profiler ---
  app.post('/api/profile', async (req, res) => {
    if (engine.isProfiling()) {
      return res.status(409).json({ error: 'Profiling already in progress' });
    }
    const ticks = typeof req.body?.ticks === 'number' ? Math.min(5000, Math.max(100, req.body.ticks)) : 1000;
    res.json({ ok: true, ticks, message: 'Profiling started — poll GET /api/profile for results' });
    engine.startProfiling(ticks).then(result => {
      (engine as any)._lastProfileResult = result;
      console.log(`[Profile] Done — ${result.ticks} ticks captured`);
      for (const [stage, stats] of Object.entries(result.stages)) {
        console.log(`  ${stage.padEnd(10)} avg=${stats.avgUs.toFixed(1)}µs  p50=${stats.p50Us.toFixed(1)}µs  p99=${stats.p99Us.toFixed(1)}µs  max=${stats.maxUs.toFixed(1)}µs`);
      }
    });
  });

  app.get('/api/profile', (_req, res) => {
    if (engine.isProfiling()) {
      return res.json({ status: 'profiling' });
    }
    const data = (engine as any)._lastProfileResult;
    if (data) {
      res.json({ status: 'done', ...data });
    } else {
      res.json({ status: 'idle' });
    }
  });

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
