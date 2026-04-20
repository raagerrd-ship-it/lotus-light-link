/**
 * Config server — Express API for mobile configuration.
 * API-only — the web UI is served by a separate frontend process.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import express from 'express';
import { getItem, setItem } from './storage.js';
import { bleStats, getConnectedCount, getConnectedNames, setDimmingGamma, getDimmingGamma, sendRawColor, scanForDevices, selectDevice, forgetDevice, saveManualDevice, getLastScanResults, getSavedDeviceId, getSavedDeviceName, getSavedDeviceAddress, getSavedAddressType, getSavedConnectable, getSavedServiceUuids, getConnectedDeviceId, isScanning, isDemandActive, requestConnect, releaseDemand, getAdapterState, getConnectionLog, processHasBtCaps, BLE_BUILD_TAG, noble, isConnectInProgress, resetHciAdapter, disconnect, workaroundCounters, autoConnectSaved, waitForFirstStateChange, getBleBootStartedAt, getFirstStateChangeAt, hasNobleEverFiredStateChange, getScanMetrics, getBootPhase, ensureAdapterUp, getMinWriteIntervalMs, setMinWriteIntervalMs } from './nobleBle.js';
import { bumpWorkaround, getHciProbeSnapshot, getForceMutationSnapshot, getAllSubsystemStates, getSubsystemState, type SubsystemId } from './ble/state.js';
import { getWatchdogGiveUpReason } from './ble/watchdog.js';
import type { GainCalPoint } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, getLastSuccessfulPollAt as getSonosLastPollAt, type SonosPollerConfig } from './sonosPoller.js';
import { getPipelineTimingSnapshot, resetPipelineTiming } from './pipelineTiming.js';

type AlsaMicModule = typeof import('./alsaMic.js');

let attachedEngine: PiLightEngine | null = null;
let attachedMic: AlsaMicModule | null = null;
let invalidateIdleColorCacheFn: (() => void) | null = null;

export interface SubsystemStarters {
  startBleEngine: () => Promise<void>;
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

// Version info — cached at boot. We NEVER call execSync on a request path
// because it blocks libuv (verified: 3× 3s git timeouts on every /api/status
// poll caused noble stateChange events to be missed and the whole API to
// "hang" for the UI).
let SERVICE_VERSION = '1.0.0';
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
const START_TIME = Date.now();
let lastVersionRefreshAt = 0;
const VERSION_REFRESH_TTL_MS = 60_000;
let versionWarningLogged = false;

/** Read VERSION.json only — never execSync on the hot path. */
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
    console.warn(`[Config] VERSION.json not found — using fallback v${SERVICE_VERSION}/${GIT_COMMIT_SHORT} (git fallback disabled på request-path för att skydda libuv)`);
  }
}

// Boot-time read (synchronous file I/O is fine, only runs once)
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
  const requireBleReady = (res: any): boolean => {
    const bootPhase = getBootPhase();
    if (bootPhase === 'ready') return true;
    const subsystem = getSubsystemState('bleEngine');
    res.status(503).json({
      error: subsystem.status === 'idle'
        ? 'BLE-motorn är inte startad — tryck "Starta BLE-motor" i UI:t'
        : subsystem.status === 'starting'
          ? 'BLE-motorn startar fortfarande — vänta några sekunder'
          : subsystem.status === 'error'
            ? `BLE-motorn fick fel: ${subsystem.error ?? 'okänt'} — tryck "Starta BLE-motor" igen`
            : 'BLE bootar fortfarande — vänta tills init är klar',
      bootPhase,
      subsystem,
      adapterState: getAdapterState() ?? 'unknown',
      watchdogReason: getWatchdogGiveUpReason(),
    });
    return false;
  };

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

  // ─── Subsystem manual-start API ───
  // GET status för alla subsystem (idle/starting/ready/error)
  app.get('/api/subsystem/status', (_req, res) => {
    res.json({
      bootPhase: getBootPhase(),
      subsystems: getAllSubsystemStates(),
    });
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
      if (id === 'bleEngine') await _starters.startBleEngine();
      else if (id === 'mic') await _starters.startMic();
      else if (id === 'sonos') await _starters.startSonos();
      else return res.status(400).json({ error: `Okänt subsystem: ${id}` });
      res.json({ ok: true, subsystem: getSubsystemState(id) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e), subsystem: getSubsystemState(id) });
    }
  };

  app.post('/api/subsystem/ble-engine/start', (_req, res) => startSubsystem('bleEngine', res));
  app.post('/api/subsystem/mic/start',        (_req, res) => startSubsystem('mic', res));
  app.post('/api/subsystem/sonos/start',      (_req, res) => startSubsystem('sonos', res));

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
    const engine = getEngine();
    res.json({
      ok: true,
      bootPhase: getBootPhase(),
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
        watchdogReason: getWatchdogGiveUpReason(),
      },
      commit: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
      version: SERVICE_VERSION,
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
  // Förenklat BLE-flöde (hårdkodad enhet, scan-then-connect).
  // Speglar pi/scripts/noble-scan-isolated.mjs som verifierat fungerar.
  //
  // POST /api/ble/engine/start  → lazy-laddar noble + väntar poweredOn
  // POST /api/ble/connect        → scan-then-connect mot HARDCODED_DEVICE
  // POST /api/ble/disconnect     → kopplar från
  // GET  /api/ble/state          → { engineReady, connected, device }
  // ─────────────────────────────────────────────────────────────────────
  app.post('/api/ble/engine/start', async (_req, res) => {
    const { resetEngineLogs } = await import('./ble/log-buffer.js');
    resetEngineLogs();
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

  app.get('/api/ble/engine/logs', async (req, res) => {
    const since = Number(req.query.since ?? 0) || 0;
    const { getEngineLogsSince } = await import('./ble/log-buffer.js');
    res.json(getEngineLogsSince(since));
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

  // --- BLE Device Management (legacy — söka/spara/forget används inte längre av UI) ---
  app.post('/api/ble/scan', async (_req, res) => {
    if (!requireBleReady(res)) return;
    if (isScanning()) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    try {
      const devices = await scanForDevices(4000);
      res.json({ ok: true, devices, adapterState: getAdapterState(), scan: getScanMetrics() });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'BLE scan failed', adapterState: getAdapterState(), scan: getScanMetrics() });
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
    if (!requireBleReady(res)) return;
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

    const engine = requireEngine(res);
    if (!engine) return;
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
  // Efter save: kör en kort preview (anslut → 5s blink → disconnect) så
  // användaren ser direkt att rätt lampa svarar. Preview körs fire-and-forget
  // — HTTP-svaret returneras direkt med previewStarted=true.
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

      // Fire-and-forget preview (5s connect+blink+disconnect).
      let previewStarted = false;
      const engineInstance = getEngine();
      const bleBootReady = getBootPhase() === 'ready';
      if (bleBootReady && engineInstance) {
        previewStarted = true;
        void (async () => {
          try {
            await autoConnectSaved(8000);
            if (!getConnectedDeviceId()) {
              console.log('[BLE] save-manual preview: connect failed — skipping blink');
              return;
            }
            engineInstance.setPlaying(true);
            await new Promise(r => setTimeout(r, 5000));
            engineInstance.setPlaying(false);
            const m = await import('./nobleBle.js');
            await m.disconnect();
            console.log('[BLE] save-manual preview done — disconnected (saved for later)');
          } catch (e: any) {
            console.error('[BLE] save-manual preview error:', e?.message ?? e);
          }
        })();
      }

      res.json({
        ok: true,
        savedDeviceId: getSavedDeviceId(),
        savedDeviceName: getSavedDeviceName(),
        savedDeviceAddress: getSavedDeviceAddress(),
        connected: !!getConnectedDeviceId(),
        previewStarted,
        previewSeconds: previewStarted ? 5 : 0,
      });
    } catch (e: any) {
      console.error(`[BLE] saveManualDevice error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Manual connect — force BLE connection even without music playing
  app.post('/api/ble/connect', async (_req, res) => {
    if (!requireBleReady(res)) return;
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

  // Hard respawn — för fall när noble är helt wedged och en mjuk reset inte räcker.
  // Svarar 200 FÖRST, sen process.exit(1) efter 200ms så systemd respawnar tjänsten.
  // Kräver att tjänsten körs under systemd med Restart=on-failure (eller always).
  app.post('/api/ble/respawn', async (_req, res) => {
    console.warn('[API] /api/ble/respawn → process.exit(1) om 200ms (systemd ska respawna)');
    try { await disconnect(true); } catch {}
    res.json({
      ok: true,
      message: 'Process avslutas — systemd startar om tjänsten inom några sekunder.',
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    });
    // Liten fördröjning så HTTP-svaret hinner skickas
    setTimeout(() => {
      console.warn('[API] respawn: process.exit(1) NU');
      process.exit(1);
    }, 200);
  });
  // /api/ble/start — användar-trigger för att "väcka" BLE-motorn (rfkill
  // unblock + hci0 up + vänta på noble.poweredOn). Gör INGEN auto-connect till
  // sparad enhet — det sker via /api/ble/connect (manual-only-policy).
  app.post('/api/ble/start', async (_req, res) => {
    try {
      await ensureAdapterUp();
    } catch (e: any) {
      console.warn('[API] /ble/start: ensureAdapterUp failed:', e?.message ?? e);
    }
    try {
      const firstState = await waitForFirstStateChange(3000);
      console.log(`[BLE] /start: noble first stateChange = ${firstState}`);
    } catch {}

    const adapterReady = getAdapterState() === 'poweredOn';
    const connected = !!getConnectedDeviceId();
    const hasSaved = !!getSavedDeviceId();
    res.json({ ok: true, enabled: true, adapterReady, autoConnect: false, connected, hasSaved });
  });

  // Legacy /api/ble/stop — disconnectar bara, släpper inte HCI (engine alltid på).
  app.post('/api/ble/stop', async (_req, res) => {
    releaseDemand();
    try {
      await disconnect(false);
      res.json({ ok: true, enabled: true, message: 'Disconnected (BLE engine alltid på)' });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'stop failed' });
    }
  });

  app.get('/api/ble/state', (_req, res) => {
    res.json({
      enabled: true,
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
  app.get('/api/ble/diagnostics', async (_req, res) => {
    const adapterState = getAdapterState() ?? 'unknown';
    const hasCaps = processHasBtCaps();
    const events = getConnectionLog();

    // Raw noble internals (before any caps-aware override) — for OS↔noble comparison.
    // Endast om noble faktiskt är laddad: annars triggar diagnostik-endpointen
    // lazy-require av @stoprocent/noble innan användaren startat BLE-motorn,
    // vilket bryter hela lazy-loading-poängen.
    const { hasNobleLoaded } = await import('./ble/state.js');
    const nobleLoaded = hasNobleLoaded();
    const n: any = nobleLoaded ? noble : null;
    const nobleRaw = nobleLoaded ? {
      state: n?.state ?? null,
      _state: n?._state ?? null,
      adapterState: n?.adapterState ?? null,
      _adapterState: n?._adapterState ?? null,
    } : { state: null, _state: null, adapterState: null, _adapterState: null, notLoaded: true };

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

    // Boot-status så UI kan visa "Initialiserar BLE…" istället för
    // "Adaptern vaknade inte" under de första 30–90s efter kall boot.
    const bootStartedAt = getBleBootStartedAt();
    const firstStateChangeAt = getFirstStateChangeAt();
    const everPoweredOn = hasNobleEverFiredStateChange();
    const NOBLE_BOOT_GRACE_MS = 90_000;
    const bootElapsedMs = Date.now() - bootStartedAt;
    // VIKTIGT: På Pi blir rå noble.state aldrig poweredOn — den fastnar i
    // `unknown`. Effektiv adapter-state (caps-aware) är vad som faktiskt
    // räknas. Om effektiv state redan är poweredOn (eller adaptern har caps
    // OK) är vi KLARA att aktivera radion — knappen ska INTE blockeras
    // bara för att vi väntar på en stateChange-event som aldrig kommer.
    const adapterReady = adapterState === 'poweredOn' || hasCaps;
    const stillBooting = !everPoweredOn && !adapterReady && bootElapsedMs < NOBLE_BOOT_GRACE_MS;

    // ── Pipeline-checklista — ett steg-för-steg "vad är online?"-svar
    // som UI:t kan rendera som bockrutor istället för att gräva i loggar.
    const probe = getHciProbeSnapshot();
    const forceMut = getForceMutationSnapshot();
    const hciUpRunning = /UP\s+RUNNING/.test(hciRaw);
    const rfkillUnblocked = !/Soft blocked: yes|Hard blocked: yes/i.test(rfkill);
    const nobleStateOk = nobleRaw.state === 'poweredOn' || nobleRaw._state === 'poweredOn';
    // På Pi förblir rå noble.state ofta `unknown` även när BLE fungerar perfekt.
    // Vi flaggar rå-state som "ignorerad" så fort tidig stateChange fångats
    // ELLER effektiv adapter-state är redo — då är rå-värdet bara referens.
    const rawStateIgnored = (everPoweredOn || adapterReady) && !nobleStateOk;
    const savedDevice = !!getSavedDeviceId();
    const connected = getConnectedCount() > 0;

    const stepStatus = (ok: boolean, pending: boolean = false): 'ok' | 'fail' | 'pending' =>
      ok ? 'ok' : pending ? 'pending' : 'fail';

    // Mic-status (ALSA)
    const micDevice = attachedMic?.getAlsaDevice() ?? '';
    const micHasDevice = !!micDevice;
    const micLastFFTAt = attachedMic?.getLastFFTTimestamp?.() ?? 0;
    const micRunning = micLastFFTAt > 0 && (performance.now() - micLastFFTAt) < 5000;

    // Sonos-status
    const sonosCfg = getPollerConfig();
    const sonosBaseUrl = sonosCfg?.baseUrl ?? '';
    const sonosHasGateway = !!sonosBaseUrl;
    const sonosLastPollAt = getSonosLastPollAt();
    const sonosReachable = !!sonosLastPollAt && (Date.now() - sonosLastPollAt) < 15_000;

    const pipeline = [
      {
        id: 'caps',
        group: 'engine',
        label: 'Process har CAP_NET_RAW + CAP_NET_ADMIN',
        status: stepStatus(hasCaps),
        detail: hasCaps ? 'CapEff OK' : 'Saknas — kontrollera setcap på node + AmbientCapabilities',
      },
      {
        id: 'hci-socket',
        group: 'engine',
        label: 'HCI raw socket öppnar (samma syscall som noble)',
        status: probe ? stepStatus(probe.ok) : 'pending',
        detail: probe
          ? probe.ok
            ? `OK (${probe.method})`
            : `${probe.errno ?? 'FAIL'}: ${probe.error}`
          : 'Probe har inte körts ännu',
      },
      {
        id: 'rfkill',
        group: 'engine',
        label: 'rfkill bluetooth unblocked',
        status: stepStatus(rfkillUnblocked),
        detail: rfkillUnblocked ? 'OK' : 'Blocked — kör sudo rfkill unblock bluetooth',
      },
      {
        id: 'hci-up',
        group: 'engine',
        label: 'hci0 UP RUNNING',
        status: stepStatus(hciUpRunning),
        detail: hciUpRunning ? 'OK' : (hciError ?? 'hci0 nere — sudo hciconfig hci0 up'),
      },
      {
        id: 'noble-state',
        group: 'engine',
        label: 'noble stateChange-event fångat (informativt)',
        // Om BLE-motorn är effektivt redo (caps + hci0 UP) räknas det INTE
        // som ett fel att noble's JS-state-flagga ligger kvar på 'unknown'.
        // På Pi händer det normalt och påverkar inte scan/connect.
        status: everPoweredOn ? 'ok' : (adapterReady ? 'pending' : (stillBooting ? 'pending' : 'fail')),
        detail: everPoweredOn
          ? `OK${firstStateChangeAt ? ` — första stateChange ${Math.round((firstStateChangeAt - bootStartedAt) / 1000)}s efter boot` : ''}`
          : adapterReady
            ? 'Inget event fångat — men BLE-motor är operativ via effektiv state. Detta är normalt på Pi.'
            : stillBooting
              ? `Väntar på första stateChange (${Math.round(bootElapsedMs / 1000)}s av ${NOBLE_BOOT_GRACE_MS / 1000}s)`
              : 'Ingen stateChange fångad och adaptern är inte redo — kontrollera boot/import-ordning',
      },
      {
        id: 'noble-raw-reference',
        group: 'engine',
        label: 'noble.state (rå JS-flagga, endast referens på Pi)',
        status: nobleStateOk ? 'ok' : (adapterReady ? 'ok' : 'pending'),
        detail: nobleStateOk
          ? `OK (${nobleRaw.state ?? nobleRaw._state})`
          : adapterReady
            ? `Rå state är ${nobleRaw.state ?? nobleRaw._state ?? 'unknown'} — ignoreras eftersom effektiv adapter redan är poweredOn`
            : 'Kan ligga kvar på unknown på Pi tills adaptern svarar',
      },
      {
        id: 'force-mutation',
        group: 'engine',
        label: 'Ingen force-mutation av noble.state används',
        status: 'ok',
        detail: 'Korrekt strategi: vänta på riktig stateChange vid boot; mutera aldrig _state manuellt',
      },
      {
        id: 'noble-guard-patch',
        group: 'engine',
        label: 'Ingen runtime-bypass av noble scan/connect-guard behövs',
        status: 'ok',
        detail: 'Använder tidig stateChange-cache + effektiv adapterstatus i stället för patchar',
      },
      {
        id: 'adapter-effective',
        group: 'engine',
        label: 'Effektiv adapter-state poweredOn',
        status: stepStatus(adapterReady, stillBooting),
        detail: adapterReady ? `OK (${adapterState})` : `${adapterState}`,
      },
      {
        id: 'saved-device',
        group: 'lamp',
        label: 'Sparad enhet finns',
        status: stepStatus(savedDevice),
        detail: savedDevice ? (getSavedDeviceName() ?? getSavedDeviceId() ?? 'OK') : 'Ingen — gör en scan + välj enhet',
      },
      {
        id: 'connected',
        group: 'lamp',
        label: 'Ansluten till enhet',
        status: stepStatus(connected),
        detail: connected
          ? `${getConnectedCount()} enhet(er)`
          : savedDevice
            ? 'Ej ansluten — tryck Anslut'
            : '—',
      },
      {
        id: 'mic-device',
        group: 'mic',
        label: 'ALSA-enhet vald',
        status: stepStatus(micHasDevice),
        detail: micHasDevice ? micDevice : 'Ingen mic-enhet konfigurerad',
      },
      {
        id: 'mic-running',
        group: 'mic',
        label: 'Mikrofon samplar (FFT-frames inom 5s)',
        status: stepStatus(micRunning, micHasDevice && !micRunning),
        detail: micRunning
          ? `OK — senaste FFT ${Math.round(performance.now() - micLastFFTAt)}ms sedan`
          : micHasDevice
            ? 'Inga FFT-frames på senaste 5s — mic stoppad eller native ALSA binding ej laddad'
            : '—',
      },
      {
        id: 'sonos-gateway',
        group: 'sonos',
        label: 'Sonos gateway konfigurerad',
        status: stepStatus(sonosHasGateway),
        detail: sonosHasGateway ? sonosBaseUrl : 'Ingen baseUrl satt — Cast Away ej upptäckt',
      },
      {
        id: 'sonos-reachable',
        group: 'sonos',
        label: 'Senaste status-poll lyckades (<15s)',
        status: stepStatus(sonosReachable, sonosHasGateway && !sonosReachable),
        detail: sonosLastPollAt
          ? `Senaste OK ${Math.round((Date.now() - sonosLastPollAt) / 1000)}s sedan`
          : sonosHasGateway
            ? 'Ingen lyckad poll ännu'
            : '—',
      },
    ];

    res.json({
      adapter: {
        state: adapterState,
        hasCaps,
        nobleRaw,
        hci: { raw: hciRaw, error: hciError },
        rfkill,
      },
      pipeline,
      hciProbe: probe,
      boot: {
        phase: getBootPhase(),
        startedAt: new Date(bootStartedAt).toISOString(),
        elapsedMs: bootElapsedMs,
        firstStateChangeAt: firstStateChangeAt ? new Date(firstStateChangeAt).toISOString() : null,
        everPoweredOn,
        stillBooting,
        graceMs: NOBLE_BOOT_GRACE_MS,
      },
      watchdog: {
        giveUpReason: getWatchdogGiveUpReason(),
      },
      build: {
        bleTag: BLE_BUILD_TAG,
      },
      enabled: true,
      enabledMeta: {
        source: 'always-on',
        changedAt: new Date(getBleBootStartedAt()).toISOString(),
        wasEnabledBeforeRestart: true,
      },
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
      scan: getScanMetrics(),
      events,
    });
  });

  // --- Pipeline timing (live latency p50/p95/p99 per stage) ---
  // Stages:
  //   audioToFft = ALSA buffer arrival → FFT frame complete
  //   fftToTick  = FFT complete → engine tick start (event-driven scheduling)
  //   tickInner  = engine processing (math + dynamics + onset + colorcal + emit)
  //   bleWrite   = noble writeAsync resolve (write-without-response: enqueue cost)
  //   endToEnd   = ALSA buffer arrival → engine tick complete (BLE enqueued)
  // Add ~3-5ms for actual radio TX + BLEDOM controller delay (not measurable from userspace).
  app.get('/api/pipeline/timing', (_req, res) => {
    const snapshot = getPipelineTimingSnapshot();
    const tickMs = attachedEngine?.getTickMs() ?? 0;
    const fftFrames = attachedMic?.getFFTFrameCount?.() ?? 0;
    res.json({
      ok: true,
      tickMs,
      tickHzMax: tickMs > 0 ? Math.round(1000 / tickMs) : 0,
      fftFramesTotal: fftFrames,
      stages: snapshot,
      summary: {
        median_total_ms: snapshot.endToEnd.p50Ms,
        p95_total_ms: snapshot.endToEnd.p95Ms,
        p99_total_ms: snapshot.endToEnd.p99Ms,
        // Estimated wall-clock latency including BLE radio:
        // endToEnd (measured) + ~3.75ms median connection event wait + ~1.5ms BLEDOM controller
        estimated_wall_clock_median_ms: Math.round((snapshot.endToEnd.p50Ms + 5.25) * 10) / 10,
      },
      note: 'endToEnd excludes BLE radio TX (~3.75ms median) and BLEDOM controller (~1.5ms). Add ~5ms to estimate user-visible latency.',
    });
  });

  app.post('/api/pipeline/timing/reset', (_req, res) => {
    resetPipelineTiming();
    res.json({ ok: true });
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
      invalidateIdleColorCacheFn?.(); // clear cache when engine runtime has attached
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
      // BLE rate-limit auto-följer (tickMs - 2) via setTickMs() — exponera båda.
      res.json({ ok: true, tickMs, minWriteIntervalMs: Math.max(5, tickMs - 2) });
    } else {
      res.status(400).json({ error: 'tickMs must be 5-50 (rate-limit auto-följer)' });
    }
  });

  // --- BLE write rate-limit (live-tweakbar för att hitta lampans tak) ---
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

  // --- BLE Auto-tune (sweep tickMs, hitta lägsta som håller fftDropped=0 + writeFail=0) ---
  // Sekvens: 30 → 25 → 20 → 15 → 12 → 10 → 8 → 7.5 ms, 5s/steg.
  // Mäter delta för fftDroppedCount och writeFailCount per block.
  // Sätter automatiskt den lägsta nivån som höll båda = 0.
  // OBS: Spela musik under hela sweepen — annars är delta-skip 100% och vi mäter ingenting meningsfullt.
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
      tickMs: number;
      fftDropped: number;
      writeFail: number;
      writeStuck: number;
      sent: number;
      passed: boolean;
    }> = [];

    console.log(`[Autotune] Start — sweep ${STEPS.length} steg, ${BLOCK_MS}ms/steg, original=${originalTickMs}ms`);

    try {
      for (const step of STEPS) {
        engine.setTickMs(step);
        engine.restartTimer();
        // Settle: vänta ut tidigare ticks innan vi börjar mäta
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

        results.push({
          tickMs: step,
          fftDropped: fftDelta,
          writeFail: failDelta,
          writeStuck: stuckDelta,
          sent: sentDelta,
          passed,
        });
        console.log(`[Autotune] tickMs=${step} → fftDropped=${fftDelta} writeFail=${failDelta} writeStuck=${stuckDelta} sent=${sentDelta} ${passed ? '✓' : '✗'}`);
      }

      // Lägsta tickMs som klarade alla tre nollvillkor
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

  // --- Live mic level (poll-friendly, ~5 Hz) ---
  // Tracks delta-rate (sent/skip per second) so the UI badge can distinguish:
  //   - low pkt/s + high skipDelta = same color repeatedly (engine output stable)
  //   - low pkt/s + high skipBusy  = BLE writeAsync slower than tick (BLEDOM cap)
  //   - low pkt/s + low skips      = engine not ticking (FFT/audio issue)
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
    let audioToBleLatencyMs: number | null = null;
    let ble: any = null;
    try {
      const { getLastWriteTime } = await import('./ble/protocol.js');
      const { bleStats } = await import('./ble/state.js');
      const tAudio = mic.getLastAudioTimestamp();
      const tBle = getLastWriteTime();
      if (tAudio > 0 && tBle > 0) {
        const delta = tBle - tAudio;
        if (delta >= 0 && delta < 500) audioToBleLatencyMs = Math.round(delta);
      }
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

      // Snapshot writeLatMaxMs sedan reset så vi ser peak senaste sekunden
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
        sentPerSec,
        skipDeltaPerSec,
        skipBusyPerSec,
        skipInFlightPerSec,
        skipRateLimitPerSec,
        fftDroppedPerSec,
        writeFailPerSec,
        writeStuckPerSec,
        writeLatAvgMs: bleStats.writeLatAvgMs,
        writeLatMaxMs,
        fftPerSec,
        tickPerSec,
        // Tick-pipeline-utfall (per sekund)
        tickOkPerSec,
        tickAbortNoMicPerSec,
        tickAbortNoChangePerSec,
        tickAbortNoDevicePerSec,
      };
    } catch { /* protocol module not loaded yet */ }
    res.json({
      active: true,
      totalRms: b.totalRms,
      bassRms: b.bassRms,
      midHiRms: b.midHiRms,
      backend: mic.getMicBackend(),
      audioToBleLatencyMs,
      tickMs,
      ble,
    });
  });

  // --- Live BLE output (sista färg + brightness skickad till lampan) ---
  // Används av lamp-rutan i UI:t som VU-meter för att verifiera att engine
  // faktiskt skickar data, och att lampan inte bara är ansluten utan också
  // får färgkommandon.
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
   // Saved gain-cal points appliceras först när alsaMic har attachats efter BLE-init.

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

  // Detect Sonos gateway på alla PCC-cores (port 3050–3053 = motor-portar för core 0–3).
  // Kräver att service-namnet innehåller "sonos" — cast-away/buddy ensamt räcker inte
  // längre eftersom andra tjänster också kan matcha de namnen.
  //
  // Gateway:n (sonos-buddy-engine) exponerar /api/status och /api/events DIREKT under
  // /api — INTE under /api/sonos. Vi probar därför båda varianterna och väljer den
  // som faktiskt svarar OK på {baseUrl}/status.
  app.get('/api/sonos-gateway/detect', async (_req, res) => {
    const CORE_PORTS = [3050, 3051, 3052, 3053];
    const probes = CORE_PORTS.map(async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return null;
        const data = await r.json();
        const name = String(data?.service ?? '').toLowerCase();
        if (!name.includes('sonos')) return null;

        // Hitta rätt base-URL: först /api/sonos (legacy cast-away-bridge),
        // sen /api (sonos-buddy-engine direkt).
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
    const engine = requireEngine(res);
    if (!engine) return;
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
    sendRawColor(0, 0, 0);
    fadeRunning = false;
    getEngine()?.resume(); // Resume engine on manual stop if runtime is attached
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
    const engine = requireEngine(res);
    if (!engine) return;
    if (engine.isRecording()) {
      return res.status(409).json({ error: 'Recording already in progress' });
    }
    const durationMs = typeof req.body?.durationMs === 'number' ? Math.min(10000, Math.max(1000, req.body.durationMs)) : 5000;
    res.json({ ok: true, durationMs });
    engine.startRecording(durationMs).then(data => {
      (engine as any)._lastRecordingData = data;
    });
  });

  app.get('/api/diagnostics/recording', (_req, res) => {
    const engine = getEngine();
    if (!engine) return res.json({ status: 'booting' });
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
    const engine = requireEngine(res);
    if (!engine) return;
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
    const engine = getEngine();
    if (!engine) return res.json({ status: 'booting' });
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
