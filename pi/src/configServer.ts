/**
 * Config server — Express API for mobile configuration.
 * API-only — the web UI is served by a separate frontend process.
 */

import { readFileSync } from 'fs';
import express from 'express';
import { getItem, setItem, getStorageDiagnostics } from './storage.js';
import {
  bleStats, BLE_BUILD_TAG,
  setDimmingGamma, getDimmingGamma,
  getSlotLeaseMs, setSlotLeaseMs,
  getAllSubsystemStates, getSubsystemState, getSubsystemTransitions, type SubsystemId,
} from './ble/index.js';
import type { GainCalPoint } from './alsaMic.js';
import type { PiLightEngine } from './piEngine.js';
import { getSonosState, getPollerConfig, stopSonosPoller, startSonosPoller, setAutoTvMode, getAutoTvMode, getLastSuccessfulPollAt as getSonosLastPollAt, type SonosPollerConfig } from './sonosPoller.js';
// lightRecorder borttaget (2026-06-02): inspelning/offline-playback avvecklad.


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

// ── Profiles (4 oberoende kalibreringsprofiler) ──
type ProfileCal = Record<string, any>;
const PROFILE_NAMES = ['Lugn', 'Normal', 'Party', 'Custom'] as const;
type ProfileName = typeof PROFILE_NAMES[number];

// Defaults speglar PRESET_CALS i src/pages/PiMobile.tsx — om de ändras där,
// uppdatera även här. Båda måste vara i sync vid första boot/seed.
const DEFAULT_PROFILES: Record<ProfileName, ProfileCal> = {
  Lugn:   { bassWeight: 0.7, attackAlpha: 0.061, releaseAlpha: 0.025, dynamicDamping: -1.5, brightnessFloor: 3, punchWhiteThreshold: 100, perceptualGamma: 2.2, transientGain: 0.7, dynamicsEnabled: true, onsetThreshold: 2.0, onsetRefractoryMs: 150, onsetEnergyFloor: 0.01, tickEnergyFloor: 0.01, flickerDeadband: 0.025, beatCutoffHz: 150 },
  Normal: { bassWeight: 0.8, attackAlpha: 1.0,   releaseAlpha: 0.15,  dynamicDamping: 0,    brightnessFloor: 5, punchWhiteThreshold: 100, perceptualGamma: 0.9, transientGain: 0.8, dynamicsEnabled: false, onsetThreshold: 1.8, onsetRefractoryMs: 200, onsetEnergyFloor: 0.01, tickEnergyFloor: 0.01, flickerDeadband: 0.02, beatCutoffHz: 150 },
  Party:  { bassWeight: 0.3, attackAlpha: 1.0,   releaseAlpha: 0.5,   dynamicDamping: 1.5,  brightnessFloor: 0, punchWhiteThreshold: 93,  perceptualGamma: 1.5, transientGain: 1.5, dynamicsEnabled: true, onsetThreshold: 1.6, onsetRefractoryMs: 90, onsetEnergyFloor: 0.01, tickEnergyFloor: 0.01, flickerDeadband: 0.005, beatCutoffHz: 150 },
  Custom: { bassWeight: 0.5, attackAlpha: 1.0,   releaseAlpha: 0.025, dynamicDamping: 0,    brightnessFloor: 0, punchWhiteThreshold: 100, perceptualGamma: 0,   transientGain: 0.5, dynamicsEnabled: true, onsetThreshold: 3.0, onsetRefractoryMs: 110, onsetEnergyFloor: 0.01, tickEnergyFloor: 0.01, flickerDeadband: 0.02, beatCutoffHz: 150 },
  // bassWeight semantik: 0=bara disk, 0.5=neutral (båda 100%), 1.0=bara bas. Asymmetrisk dämpning av "andra" sidan.
  // saturation/maxRisePerSec/maxFallPerSec/hiShelfGainDb borttagna 2026-05-04 — ingen runtime-effekt.
};

interface ProfilesFile {
  profiles: Record<string, ProfileCal>;
  activePreset: ProfileName;
}

function loadProfilesFile(): ProfilesFile {
  try {
    const raw = getItem('profiles');
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.profiles && p?.activePreset) {
        // Säkerställ att alla 4 namn finns (forward-kompat)
        const merged: Record<string, ProfileCal> = { ...DEFAULT_PROFILES };
        for (const name of PROFILE_NAMES) {
          if (p.profiles[name]) merged[name] = { ...DEFAULT_PROFILES[name], ...p.profiles[name] };
        }
        const active = PROFILE_NAMES.includes(p.activePreset) ? p.activePreset : 'Normal';
        return { profiles: merged, activePreset: active };
      }
    }
  } catch {}
  // Första boot: seed:a med defaults. Om en gammal /api/calibration finns
  // (light-calibration), pluggar vi in den i Normal så användaren inte
  // tappar sin nuvarande inställning.
  const seeded: Record<string, ProfileCal> = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
  try {
    const legacy = getItem('light-calibration');
    if (legacy) {
      const lc = JSON.parse(legacy);
      seeded.Normal = { ...seeded.Normal, ...lc };
    }
  } catch {}
  return { profiles: seeded, activePreset: 'Normal' };
}

function saveProfilesFile(p: ProfilesFile): void {
  setItem('profiles', JSON.stringify(p));
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

  // Seed profiles.json vid behov + applicera aktiv profil i pipelinen
  try {
    const pf = loadProfilesFile();
    if (!getItem('profiles')) saveProfilesFile(pf);
    runtime.engine.setActiveProfile(pf.profiles[pf.activePreset]);
    console.log(`[Config] Active profile: ${pf.activePreset}`);
  } catch (e: any) {
    console.warn('[Config] Profile seed failed:', e?.message ?? e);
  }

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

  // ─── Runtime permissions self-check ───
  // Frontend visar en "Setup måste köras"-banner om något saknas.
  // Detta händer typiskt när PCC packar upp release utan att köra setup-lotus.sh
  // (managed:false + runInstallOnRelease:false).
  app.get('/api/permissions', async (_req, res) => {
    const fs = await import('node:fs');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const result: {
      ok: boolean;
      rfkillAccess: boolean;
      rfkillError: string | null;
      groups: string[];
      hasNetdev: boolean;
      hasBluetooth: boolean;
      hasAudio: boolean;
      uid: number;
      // Self-check additions (PCC verifierar runtime-perms efter release)
      nodeCaps: string | null;        // getcap-output på process.execPath
      hasNetRaw: boolean;             // CAP_NET_RAW i caps eller ambient
      hasNetAdmin: boolean;           // CAP_NET_ADMIN i caps eller ambient
      bluetoothdActive: boolean;      // systemctl is-active bluetooth
      bluetoothdStatus: string;       // raw output
      nobleState: string;             // 'poweredOn' | 'unknown' | ...
      storage: Array<{ name: string; path: string; writable: boolean; error: string | null }>;
      missing: string[];
      setupCommand: string;
    } = {
      ok: false,
      rfkillAccess: false,
      rfkillError: null,
      groups: [],
      hasNetdev: false,
      hasBluetooth: false,
      hasAudio: false,
      uid: process.getuid?.() ?? -1,
      nodeCaps: null,
      hasNetRaw: false,
      hasNetAdmin: false,
      bluetoothdActive: false,
      bluetoothdStatus: 'unknown',
      nobleState: 'unknown',
      storage: [],
      missing: [],
      setupCommand: (() => {
        const cfgPort = Number(process.env.PORT ?? process.env.ENGINE_PORT ?? process.env.BACKEND_PORT ?? 3050);
        const uiPort = process.env.UI_PORT ? Number(process.env.UI_PORT) : Math.max(1, cfgPort - 50);
        const core = Number(process.env.PCC_CORE ?? process.env.CPU_CORE ?? 1);
        return `sudo bash /opt/lotus-light/pi/setup-lotus.sh --port ${uiPort} --core ${core}`;
      })(),
    };

    // 1. /dev/rfkill access
    try {
      fs.accessSync('/dev/rfkill', fs.constants.R_OK | fs.constants.W_OK);
      result.rfkillAccess = true;
    } catch (e: any) {
      result.rfkillError = e?.code ?? String(e);
    }

    // 2. Supplementary groups
    try {
      const { stdout } = await exec('id', ['-Gn']);
      result.groups = stdout.trim().split(/\s+/);
    } catch {}
    result.hasNetdev    = result.groups.includes('netdev');
    result.hasBluetooth = result.groups.includes('bluetooth');
    result.hasAudio     = result.groups.includes('audio');

    // 3. Node-binary caps (getcap) + ambient caps från /proc/self/status
    try {
      const { stdout } = await exec('getcap', [process.execPath], { timeout: 1500 });
      result.nodeCaps = stdout.trim() || '(none)';
    } catch (e: any) {
      result.nodeCaps = `error: ${e?.code ?? e?.message ?? 'unknown'}`;
    }
    try {
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const ambLine = status.match(/^CapAmb:\s+([0-9a-fA-F]+)/m);
      const effLine = status.match(/^CapEff:\s+([0-9a-fA-F]+)/m);
      const ambHex = ambLine ? BigInt('0x' + ambLine[1]) : 0n;
      const effHex = effLine ? BigInt('0x' + effLine[1]) : 0n;
      const combined = ambHex | effHex;
      // CAP_NET_ADMIN = 12, CAP_NET_RAW = 13
      const CAP_NET_ADMIN = 1n << 12n;
      const CAP_NET_RAW   = 1n << 13n;
      result.hasNetAdmin = (combined & CAP_NET_ADMIN) !== 0n;
      result.hasNetRaw   = (combined & CAP_NET_RAW)   !== 0n;
    } catch {}
    // Fallback: getcap-output kan visa caps även om CapEff är tom (file caps på binär)
    if (result.nodeCaps && /cap_net_raw/i.test(result.nodeCaps))   result.hasNetRaw = true;
    if (result.nodeCaps && /cap_net_admin/i.test(result.nodeCaps)) result.hasNetAdmin = true;

    // 4. bluetoothd active
    try {
      const { stdout } = await exec('systemctl', ['is-active', 'bluetooth'], { timeout: 1500 });
      result.bluetoothdStatus = stdout.trim();
      result.bluetoothdActive = result.bluetoothdStatus === 'active';
    } catch (e: any) {
      // is-active returnerar exit-code != 0 om inte aktiv → execFile rejectar.
      // Men: i vissa PCC-miljöer saknas systemctl i PATH, eller execFile
      // timeout:ar — då får vi 'error' utan att tjänsten faktiskt är nere.
      // Behandla som okänt (verifieras senare via nobleState nedan).
      result.bluetoothdStatus = e?.stdout?.toString().trim() || (e?.code ?? 'error');
      result.bluetoothdActive = false;
    }

    // 5. noble adapter state
    try {
      const mod = await import('./ble-driver/noble-singleton.js');
      const noble: any = (mod as any).getNoble?.() ?? (mod as any).noble ?? null;
      if (noble) {
        result.nobleState = noble.state ?? noble._state ?? 'unknown';
      }
    } catch {}

    // Om noble är poweredOn så ÄR bluetoothd uppe per definition (noble kan
    // inte powera upp adaptern utan en aktiv bluetoothd-stack). Override
    // systemctl-checken som kan ha failat p.g.a. PATH/timeout i PCC-miljön.
    if (result.nobleState === 'poweredOn') {
      result.bluetoothdActive = true;
      if (!['active'].includes(result.bluetoothdStatus)) {
        result.bluetoothdStatus = 'active (inferred from noble)';
      }
    }

    // Storage write access — bannern ska även visa de faktiska katalogerna
    // som save-endpoints skriver till (PCC_DATA_DIR/PCC_CONFIG_DIR).
    result.storage = getStorageDiagnostics();

    // Missing-rapport
    for (const dir of result.storage) {
      if (!dir.writable) result.missing.push(`${dir.name} ${dir.path} (${dir.error ?? 'ej skrivbar'})`);
    }
    if (!result.rfkillAccess)    result.missing.push('/dev/rfkill (BLE)');
    if (!result.hasNetdev)       result.missing.push('netdev-grupp (BLE)');
    if (!result.hasBluetooth)    result.missing.push('bluetooth-grupp (BLE)');
    if (!result.hasAudio)        result.missing.push('audio-grupp (mic)');
    if (!result.hasNetRaw)       result.missing.push('CAP_NET_RAW (BLE HCI)');
    if (!result.hasNetAdmin)     result.missing.push('CAP_NET_ADMIN (BLE HCI)');
    if (!result.bluetoothdActive) result.missing.push(`bluetoothd (${result.bluetoothdStatus})`);
    if (result.nobleState !== 'poweredOn') result.missing.push(`noble adapter state=${result.nobleState}`);

    result.ok = result.missing.length === 0;
    res.json(result);
  });

  // ─── BLE self-test (aktivt prov) ───
  // Försöker:
  //  1. Ladda noble (lazy singleton)
  //  2. Vänta på poweredOn (max 5s)
  //  3. Köra en kort scan-start/stop (verifierar HCI-write-rättighet)
  // Returnerar steg-för-steg resultat så UI:t kan peka på exakt fel.
  app.post('/api/permissions/ble-selftest', async (_req, res) => {
    const steps: Array<{ step: string; ok: boolean; detail?: string; ms?: number }> = [];
    const t0 = Date.now();
    let noble: any = null;

    // Step 1: load noble singleton (via async loader — synkron getNoble() kastar om ej laddad)
    const s1 = Date.now();
    try {
      const mod = await import('./ble-driver/noble-singleton.js');
      const loader = (mod as any).getNobleAsync ?? (mod as any).getNoble;
      if (typeof loader !== 'function') throw new Error('noble-singleton saknar getNobleAsync/getNoble');
      noble = await loader();
      steps.push({ step: 'load-noble', ok: !!noble, ms: Date.now() - s1, detail: noble ? 'singleton ok' : 'loader returnerade null' });
      if (!noble) return res.json({ ok: false, durationMs: Date.now() - t0, steps });
    } catch (e: any) {
      steps.push({ step: 'load-noble', ok: false, ms: Date.now() - s1, detail: e?.message ?? String(e) });
      return res.json({ ok: false, durationMs: Date.now() - t0, steps });
    }

    // Step 2: wait for poweredOn (max 5s)
    const s2 = Date.now();
    const initial = noble.state ?? noble._state ?? 'unknown';
    if (initial === 'poweredOn') {
      steps.push({ step: 'wait-poweredOn', ok: true, ms: 0, detail: 'already poweredOn' });
    } else {
      const reached = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        const onState = (st: string) => {
          if (st === 'poweredOn') {
            clearTimeout(timeout);
            try { noble.removeListener?.('stateChange', onState); } catch {}
            resolve(true);
          }
        };
        try { noble.on?.('stateChange', onState); } catch { resolve(false); }
      });
      const stateNow = noble.state ?? noble._state ?? 'unknown';
      steps.push({
        step: 'wait-poweredOn',
        ok: reached || stateNow === 'poweredOn',
        ms: Date.now() - s2,
        detail: `state=${stateNow} (initial=${initial})`,
      });
      if (!reached && stateNow !== 'poweredOn') {
        return res.json({ ok: false, durationMs: Date.now() - t0, steps });
      }
    }

    // Step 3: scan-start/stop (verifierar HCI-write-permission)
    const s3 = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('scan-start timeout 2s')), 2000);
        try {
          noble.startScanning([], false, (err: any) => {
            clearTimeout(timeout);
            if (err) reject(err); else resolve();
          });
        } catch (e) { clearTimeout(timeout); reject(e); }
      });
      try { noble.stopScanning?.(); } catch {}
      steps.push({ step: 'scan-start-stop', ok: true, ms: Date.now() - s3, detail: 'HCI write ok' });
    } catch (e: any) {
      steps.push({ step: 'scan-start-stop', ok: false, ms: Date.now() - s3, detail: e?.message ?? String(e) });
      return res.json({ ok: false, durationMs: Date.now() - t0, steps });
    }

    res.json({ ok: true, durationMs: Date.now() - t0, steps });
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

  app.post('/api/diagnostics/manual-start-all', async (req, res) => {
    try {
      const { recordRestart } = await import('./restartLog.js');
      const detail = typeof req.body?.detail === 'string'
        ? req.body.detail
        : 'Användaren tryckte Starta allt / Starta om i UI';
      recordRestart('manual-start-all', detail);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // --- Health (Pi Control Center standard) ---
  app.get('/api/health', async (_req, res) => {
    refreshVersionInfo();
    const mem = process.memoryUsage();
    const { getHardcodedConnected } = await import('./ble-driver/connect.js');
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
    const { getHardcodedConnected, getLastDisconnectReason } = await import('./ble-driver/connect.js');
    const { getRestartHistory } = await import('./restartLog.js');
    const c = getHardcodedConnected();
    // Live UI-strip: input/output/queue/palette/låt
    // Input = rå RMS efter mic-gain (samma källa som VU-mätaren i Avancerat).
    //   max(bass, midHi) * 4 → matchar VuMeter-skalningen (bassRms*400%) så att
    //   topp-stapeln i LiveStrip alltid visar samma värde som högsta band-stapeln
    //   i Avancerat. INNAN engine-smoothing/normalisering/dynamics.
    // Output = engine.brightnessPct (samma källa som /api/ble/output i Avancerat).
    //   Detta är engine-resultatet efter floor/gamma/punch — INTE sista
    //   faktiskt sända BLE-paketet (som hoppas över vid små deltan / full kö).
    const diag = engine?.getDiagnostics?.() ?? null;
    let micBass = 0, micMidHi = 0;
    try {
      const m = getMic();
      const b = m?.getLatestBands?.();
      if (b) { micBass = b.bassRms ?? 0; micMidHi = b.midHiRms ?? 0; }
    } catch {}
    const inputLevel = Math.max(0, Math.min(1, Math.max(micBass, micMidHi) * 4));
    const outputBrightness = diag ? Math.max(0, Math.min(1, (diag.brightnessPct ?? 0) / 100)) : 0;
    const { getLastSent } = await import('./ble-driver/protocol.js');
    const sent = getLastSent();
    // Kö = bara noble's _aclQueue (mjukvarukö för vår handle), INTE pending.
    // pending=1 är normalt (paketet just nu i flygning till controllern) och
    // hör inte hemma i ett "kö"-mått — då skulle värdet alltid vara ≥1.
    let queueLen = 0;
    try {
      const cd = await import('./ble-driver/controllerDrain.js');
      if (cd.isControllerDrainAttached?.()) queueLen = cd.getQueuedPackets?.() ?? 0;
    } catch {}
    let lifecycleState: string | null = null;
    let lifecycleOverride = false;
    let pendingShutdownInMs: number | null = null;
    try {
      const lc = await import('./engineLifecycle.js');
      lifecycleState = lc.getLifecycleState();
      lifecycleOverride = lc.isManualOverrideOff();
      pendingShutdownInMs = lc.getPendingShutdownInMs();
    } catch {}
    res.json({
      ok: true,
      lifecycle: { state: lifecycleState, manualOverrideOff: lifecycleOverride, pendingShutdownInMs },
      ble: {
        connected: c.connected ? 1 : 0,
        devices: c.connected ? [c.name] : [],
        stats: bleStats,
        lastSent: sent,                              // {r,g,b,brightness} | null
        outstanding: bleStats.controllerOutstandingCount ?? 0,
      },
      commit: GIT_COMMIT_SHORT,
      branch: GIT_BRANCH,
      version: SERVICE_VERSION,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      startedAt: new Date(START_TIME).toISOString(),
      sonos,
      live: {
        inputLevel,                                  // 0..1 (rå RMS×4, matchar VU-meter)
        outputBrightness,                            // 0..1 (engine brightnessPct/100)
        // Färg-rader visar nu Sonos-paletten (nuvarande + nästa låt) — inte
        // den faktiska BLE-utskickade färgen. UI:t bryr sig om "vad spelas",
        // inte om motorns mellanresultat.
        paletteCurrent: sonos?.palette ?? null,      // [r,g,b][] | null
        paletteNext: sonos?.nextPalette ?? null,     // [r,g,b][] | null
        track: sonos?.trackName ?? null,
        artist: sonos?.artistName ?? null,
        nextTrack: sonos?.nextTrackName ?? null,
        nextArtist: sonos?.nextArtistName ?? null,
        playbackState: sonos?.playbackState ?? null,
        queue: queueLen,
      },
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
      idle: engine
        ? {
            enteredAt: engine.getIdleEnteredAt?.() ?? null,
            disconnectInMs: engine.getIdleEnteredAt?.()
              ? Math.max(0, (engine.getIdleEnteredAt()! + 2 * 60 * 1000) - Date.now())
              : null,
            micPausedForIdle: engine.isMicPausedForIdle?.() ?? false,
            lastDisconnectReason: getLastDisconnectReason(),
          }
        : null,
      // Restart-historik (senaste 20, nyaste sist) — UI visar reason + tid
      // så användaren ser om motorn dör ofta och varför.
      restarts: (() => {
        try { return getRestartHistory().slice(-20); }
        catch { return []; }
      })(),
      // Subsystem-transitions (senaste 30, nyaste sist) — visar varje gång ett
      // subsystem byter status (inkl. ready→error/idle), så vi kan se exakt
      // när och varför något föll bort utan journalctl.
      subsystemTransitions: (() => {
        try { return getSubsystemTransitions().slice(-30); }
        catch { return []; }
      })(),
      // Subsystem-states — UI visar vad som är aktivt under tändning vs motor.
      subsystems: (() => {
        try { return getAllSubsystemStates(); }
        catch { return null; }
      })(),
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
      // UI "Starta allt" → lifecycle tar över hela start-sekvensen
      // (BLE-minimal → mic ∥ connect). Rensar override först.
      const { userStartAll } = await import('./engineLifecycle.js');
      const { HARDCODED_DEVICE } = await import('./ble-driver/device-config.js');
      const { getHardcodedConnected } = await import('./ble-driver/connect.js');
      await userStartAll();
      const c = getHardcodedConnected();
      if (c.connected) {
        res.json({ connected: true, name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac });
      } else {
        res.status(500).json({ connected: false, error: 'lifecycle.userStartAll did not yield BLE connection' });
      }
    } catch (e: any) {
      res.status(500).json({ connected: false, error: e?.message ?? String(e) });
    }
  });

  app.post('/api/ble/disconnect', async (_req, res) => {
    try {
      // UI "Stoppa" → lifecycle drar ner motorn och sätter override.
      const { userStopAll } = await import('./engineLifecycle.js');
      await userStopAll();
      res.json({ disconnected: true });
    } catch (e: any) {
      res.status(500).json({ disconnected: false, error: e?.message ?? String(e) });
    }
  });

  // POST /api/lifecycle/override { off: boolean }
  // Manuell override som blockerar Sonos-driven auto-start (TÄNDNING_AV).
  app.post('/api/lifecycle/override', async (req, res) => {
    try {
      const { off } = req.body ?? {};
      if (typeof off !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'body needs { off: true|false }' });
      }
      const { setManualOverrideOff, getLifecycleState } = await import('./engineLifecycle.js');
      setManualOverrideOff(off);
      res.json({ ok: true, override: off ? 'off' : null, state: getLifecycleState() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // POST /api/ble/power { on: boolean } — manuell power-toggle av lampans LED-driver.
  // BLEDOM har separat power-state från BLE-länk; denna endpoint tänder/släcker
  // lampan utan att röra connection. Auto-wake sker även automatiskt vid connect.
  app.post('/api/ble/power', async (req, res) => {
    try {
      const { on } = req.body ?? {};
      if (typeof on !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'body needs { on: true|false }' });
      }
      const { sendPower } = await import('./ble-driver/protocol.js');
      const result = await sendPower(on);
      res.json({ ok: result === 'sent', result, on });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get('/api/ble/state', async (_req, res) => {
    try {
      const { getHardcodedConnected } = await import('./ble-driver/connect.js');
      const { hasNobleLoaded } = await import('./ble-driver/state.js');
      const { HARDCODED_DEVICE } = await import('./ble-driver/device-config.js');
      let rawState: string | null = null;
      let engineReady = false;
      if (hasNobleLoaded()) {
        const { getNoble } = await import('./ble-driver/noble-singleton.js');
        const n = getNoble() as any;
        rawState = n?.state ?? n?._state ?? null;
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

  // ─────────────────────────────────────────────────────────────────────
  // BLE-enhetsval — upptäck & välj lampa istället för hårdkodad MAC.
  // GET  /api/ble/device   → { name, mac }   (aktuellt vald enhet)
  // PUT  /api/ble/device   → { name, mac }   spara + applicera
  // POST /api/ble/scan     → { devices: [{ name, mac, rssi }] }
  // ─────────────────────────────────────────────────────────────────────
  app.get('/api/ble/device', async (_req, res) => {
    try {
      const { HARDCODED_DEVICE } = await import('./ble-driver/device-config.js');
      res.json({ name: HARDCODED_DEVICE.name, mac: HARDCODED_DEVICE.mac });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.put('/api/ble/device', async (req, res) => {
    try {
      const { name, mac } = req.body ?? {};
      if (typeof name !== 'string' || typeof mac !== 'string' || !/^[0-9a-fA-F:]{11,17}$/.test(mac)) {
        return res.status(400).json({ ok: false, error: 'body needs { name: string, mac: "AA:BB:..." }' });
      }
      const { setDeviceConfig } = await import('./ble-driver/device-config.js');
      setDeviceConfig({ name, mac });
      setItem('lamp-device', JSON.stringify({ name, mac }));
      res.json({ ok: true, device: { name, mac } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post('/api/ble/scan', async (req, res) => {
    try {
      const durationMs = Math.max(2000, Math.min(15000, Number(req.body?.durationMs) || 6000));
      const { startBleEngineMinimal } = await import('./ble/engine-start-minimal.js');
      await startBleEngineMinimal();
      const { scanForDevices } = await import('./ble-driver/connect.js');
      const devices = await scanForDevices(durationMs);
      res.json({ devices });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
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
    // Spegla även i aktiv profil så /api/profiles förblir source-of-truth
    try {
      const pf = loadProfilesFile();
      pf.profiles[pf.activePreset] = { ...pf.profiles[pf.activePreset], ...req.body };
      saveProfilesFile(pf);
    } catch {}
    res.json({ ok: true });
  });

  // ── Profiles (4 oberoende kalibreringsprofiler) ──
  app.get('/api/profiles', (_req, res) => {
    res.json(loadProfilesFile());
  });

  app.put('/api/profiles', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const { profiles, activePreset } = req.body ?? {};
    if (!profiles || typeof profiles !== 'object') {
      return res.status(400).json({ error: 'Need profiles object' });
    }
    const current = loadProfilesFile();
    const mergedProfiles: Record<string, ProfileCal> = { ...current.profiles };
    for (const name of PROFILE_NAMES) {
      if (profiles[name]) mergedProfiles[name] = { ...mergedProfiles[name], ...profiles[name] };
    }
    const active: ProfileName = (activePreset && PROFILE_NAMES.includes(activePreset))
      ? activePreset : current.activePreset;
    const next: ProfilesFile = { profiles: mergedProfiles, activePreset: active };
    saveProfilesFile(next);
    engine.setActiveProfile(next.profiles[active]);
    res.json({ ok: true, ...next });
  });

  app.put('/api/active-preset', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const { name } = req.body ?? {};
    if (!name || !PROFILE_NAMES.includes(name)) {
      return res.status(400).json({ error: `name must be one of ${PROFILE_NAMES.join(', ')}` });
    }
    const pf = loadProfilesFile();
    pf.activePreset = name;
    saveProfilesFile(pf);
    engine.setActiveProfile(pf.profiles[name]);
    console.log(`[Config] Active profile → ${name}`);
    res.json({ ok: true, activePreset: name, profile: pf.profiles[name] });
  });

  // ─── Auto-tune anti-flicker ───
  // Mäter pct-rörelser i N sekunder och föreslår maxFallPerSec + flickerDeadband
  // baserat på faktisk insignal-jitter. Användaren spelar musik under tiden.
  app.post('/api/autotune/start', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const ms = Math.max(2000, Math.min(120_000, Number(req.body?.durationMs) || 30_000));
    const r = engine.startAutoTune(ms);
    console.log(`[Config] Auto-tune started (${r.durationMs}ms, cap=${r.capacity})`);
    res.json({ ...r, isPlaying: (engine as any).playing === true });
  });

  app.get('/api/autotune/status', (_req, res) => {
    const engine = getEngine();
    if (!engine) return res.status(503).json({ error: 'Engine ej redo' });
    res.json(engine.getAutoTuneStatus());
  });

  app.post('/api/autotune/cancel', (_req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    engine.cancelAutoTune();
    res.json({ ok: true });
  });

  // Skriver suggestion in i aktiv profil.
  // Klienten skickar {tickEnergyFloor, onsetEnergyFloor} så användaren kan
  // välja att inte tillämpa båda.
  app.post('/api/autotune/apply', (req, res) => {
    const engine = requireEngine(res);
    if (!engine) return;
    const { tickEnergyFloor, onsetEnergyFloor } = req.body ?? {};
    const patch: Record<string, number> = {};
    if (Number.isFinite(tickEnergyFloor)) patch.tickEnergyFloor = Math.max(0, Math.min(0.20, tickEnergyFloor));
    if (Number.isFinite(onsetEnergyFloor)) patch.onsetEnergyFloor = Math.max(0, Math.min(0.20, onsetEnergyFloor));
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Need tickEnergyFloor and/or onsetEnergyFloor' });
    }
    const pf = loadProfilesFile();
    const active = pf.activePreset;
    pf.profiles[active] = { ...pf.profiles[active], ...patch };
    saveProfilesFile(pf);
    engine.setActiveProfile(pf.profiles[active]);
    console.log(`[Config] Auto-tune applied to "${active}": ${JSON.stringify(patch)}`);
    res.json({ ok: true, activePreset: active, profile: pf.profiles[active] });
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
      res.json({ ok: true, tickMs, slotLeaseMs: tickMs });
    } else {
      res.status(400).json({ error: 'tickMs must be 5-50 (BLE slot-lease följer tick)' });
    }
  });

  // --- BLE write slot-lease (legacy alias: rate-limit) ---
  // Strict lease-slot: 1 tick = 1 BLE-paket. slotLeaseMs = engine.tickMs.
  // Detta endpoint exponerar samma värde under det gamla namnet för
  // bakåtkompatibilitet. Engine skriver över vid nästa setTickMs.
  app.get('/api/ble/rate-limit', (_req, res) => {
    const ms = getSlotLeaseMs();
    res.json({ minWriteIntervalMs: ms, slotLeaseMs: ms, maxHz: +(1000 / ms).toFixed(1) });
  });

  app.put('/api/ble/rate-limit', (req, res) => {
    const { minWriteIntervalMs } = req.body ?? {};
    const v = Number(minWriteIntervalMs);
    if (!Number.isFinite(v) || v < 5 || v > 100) {
      return res.status(400).json({ error: 'minWriteIntervalMs must be 5–100 (number) — overrides slot-lease tills nästa setTickMs' });
    }
    setSlotLeaseMs(v);
    setItem('ble-min-write-interval-ms', String(v));
    res.json({ ok: true, minWriteIntervalMs: getSlotLeaseMs(), slotLeaseMs: getSlotLeaseMs(), maxHz: +(1000 / v).toFixed(1) });
  });

  // ─── BLE bench: auto-ramp tickMs (HÖG → LÅG) ───
  // Förbigår engine, lease och delta-skip. Skickar 1 paket per tickMs över
  // stepSec sekunder och mäter queuedPeak/pendingPeak från noble live.
  // pending=8 är hårdvarutaket (ACL-buffrar) och ignoreras — bara queued
  // (=noble's _aclQueue) indikerar att vi producerar snabbare än radion.
  // Pass: queuedPeak ≤ maxQueued (default 2). LastGoodTickMs = lägsta som passade.
  let _benchRunning = false;
  let _benchLastResult: any = null;
  app.post('/api/ble/bench', async (req, res) => {
    if (_benchRunning) return res.status(409).json({ error: 'bench already running' });
    const engine = requireEngine(res);
    if (!engine) return;
    const { getDevice } = await import('./ble-driver/state.js');
    const { getNoble } = await import('./ble-driver/noble-singleton.js');
    const { getAttachedHandle, isControllerDrainAttached } = await import('./ble-driver/controllerDrain.js');
    const dev = getDevice();
    if (!dev) return res.status(503).json({ error: 'no BLE device connected' });

    const startTickMs = Math.max(10, Math.min(200, Number(req.body?.startTickMs ?? 30)));
    const endTickMs   = Math.max(5,  Math.min(startTickMs, Number(req.body?.endTickMs ?? 10)));
    const stepMs      = Math.max(1,  Math.min(20,  Number(req.body?.stepMs    ?? 5)));
    const stepSec     = Math.max(2,  Math.min(15,  Number(req.body?.stepSec   ?? 5)));
    const maxQueued   = Math.max(0,  Math.min(10,  Number(req.body?.maxQueued ?? 2)));

    // Live drain-läsning som separerar pending/queued (controllerDrain.ts
    // returnerar summan; här vill vi se dem var för sig).
    const handle = getAttachedHandle();
    const noble: any = getNoble();
    function readDrain(): { pending: number; queued: number } {
      try {
        if (handle == null) return { pending: 0, queued: 0 };
        const hci = noble?._bindings?._hci;
        const conn = hci?._aclConnections?.get?.(handle);
        const pending = conn?.pending ?? 0;
        let queued = 0;
        const q = hci?._aclQueue;
        if (Array.isArray(q)) for (let i = 0; i < q.length; i++) if (q[i]?.handle === handle) queued++;
        return { pending, queued };
      } catch { return { pending: 0, queued: 0 }; }
    }

    // Läs faktisk LE connection interval från noble (om tillgänglig).
    // Förväntat värde efter våra HCI-tweaks: ~7.5–10ms. Default annars: 50ms.
    function readConnInterval(): { intervalMs: number | null; latency: number | null; supervisionTimeoutMs: number | null; raw: string } {
      try {
        if (handle == null) return { intervalMs: null, latency: null, supervisionTimeoutMs: null, raw: 'no-handle' };
        const hci = noble?._bindings?._hci;
        const conn = hci?._aclConnections?.get?.(handle) ?? hci?._handles?.[handle];
        // BLE spec: interval i units à 1.25ms, supervision timeout i units à 10ms
        const interval = conn?.interval ?? conn?.connInterval ?? null;
        const latency  = conn?.latency  ?? conn?.connLatency  ?? null;
        const sup      = conn?.supervisionTimeout ?? conn?.timeout ?? null;
        const intervalMs = typeof interval === 'number' ? +(interval * 1.25).toFixed(2) : null;
        const supMs      = typeof sup === 'number' ? sup * 10 : null;
        const keys = conn ? Object.keys(conn).join(',') : '(no-conn)';
        return { intervalMs, latency, supervisionTimeoutMs: supMs, raw: `keys=${keys}` };
      } catch (e: any) {
        return { intervalMs: null, latency: null, supervisionTimeoutMs: null, raw: `err:${e?.message ?? e}` };
      }
    }

    _benchRunning = true;
    const buf = Buffer.from([0x7e, 0x07, 0x05, 0x03, 0, 0, 0, 0x00, 0xef]);
    const steps: any[] = [];
    let lastGoodTickMs = 0;
    let stoppedReason = 'completed';

    // PAUSA engine + keep-alive — annars blandas våra writes med engine's,
    // och queued/pending blir omöjligt att tolka. Resume i finally.
    let suspended = false;
    try { engine.suspend(); suspended = true; } catch {}
    // Vänta tills allt drainat innan vi börjar mäta.
    const drainStart = performance.now();
    while (performance.now() - drainStart < 2000) {
      const d = readDrain();
      if (d.queued === 0 && d.pending === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const preDrain = readDrain();
    const connInfoStart = readConnInterval();
    console.log(`[Bench] suspend=${suspended} preDrain pending=${preDrain.pending} queued=${preDrain.queued} connInterval=${connInfoStart.intervalMs}ms latency=${connInfoStart.latency} supTimeout=${connInfoStart.supervisionTimeoutMs}ms (${connInfoStart.raw})`);
    console.log(`[Bench] Ramp tickMs ${startTickMs}→${endTickMs} step=${stepMs} stepSec=${stepSec} maxQueued=${maxQueued} attached=${isControllerDrainAttached()} handle=${handle}`);

    try {
      for (let tickMs = startTickMs; tickMs >= endTickMs; tickMs -= stepMs) {
        const totalAttempts = Math.max(1, Math.round(stepSec * 1000 / tickMs));
        let sent = 0, failed = 0, latSum = 0, latMax = 0;
        let queuedPeak = 0, pendingPeak = 0;
        const t0 = performance.now();
        let colorIdx = 0;

        for (let i = 0; i < totalAttempts; i++) {
          const targetT = t0 + i * tickMs;
          const delay = targetT - performance.now();
          if (delay > 0) await new Promise(r => setTimeout(r, delay));
          colorIdx = (colorIdx + 1) % 256;
          buf[4] = colorIdx; buf[5] = 255 - colorIdx; buf[6] = (colorIdx * 3) & 0xff;
          const wStart = performance.now();
          try {
            await dev.characteristic.writeAsync(buf, true);
            const lat = performance.now() - wStart;
            sent++; latSum += lat; if (lat > latMax) latMax = lat;
          } catch {
            failed++;
          }
          const d = readDrain();
          if (d.queued  > queuedPeak)  queuedPeak  = d.queued;
          if (d.pending > pendingPeak) pendingPeak = d.pending;
        }

        // Vänta extra ~1s så kön töms innan nästa steg och vi mäter rent.
        const settleStart = performance.now();
        while (performance.now() - settleStart < 1000) {
          const d = readDrain();
          if (d.queued === 0) break;
          await new Promise(r => setTimeout(r, 50));
        }

        const failRate = failed / totalAttempts;
        const avgLat = sent > 0 ? latSum / sent : 0;
        const ratePps = +(1000 / tickMs).toFixed(1);
        const passed = failRate < 0.05 && queuedPeak <= maxQueued;
        const result = {
          tickMs, ratePps, attempted: totalAttempts, sent, failed,
          failRatePct: +(failRate * 100).toFixed(1),
          avgLatencyMs: +avgLat.toFixed(2),
          maxLatencyMs: +latMax.toFixed(2),
          queuedPeak, pendingPeak, passed,
        };
        steps.push(result);
        console.log(`[Bench] tick=${tickMs}ms (${ratePps} pps) sent=${sent}/${totalAttempts} fail=${failed} avgLat=${avgLat.toFixed(1)}ms queuedPk=${queuedPeak} pendingPk=${pendingPeak} → ${passed ? 'PASS' : 'FAIL'}`);

        if (passed) {
          lastGoodTickMs = tickMs;
        } else {
          stoppedReason = failRate >= 0.05
            ? `failRate ${(failRate*100).toFixed(1)}%`
            : `queuedPeak ${queuedPeak} > ${maxQueued}`;
          break;
        }
      }
    } catch (e: any) {
      stoppedReason = `error: ${e?.message ?? e}`;
    } finally {
      _benchRunning = false;
      if (suspended) { try { engine.resume(); } catch {} }
    }

    const connInfoEnd = readConnInterval();
    _benchLastResult = {
      ok: true, finishedAt: new Date().toISOString(),
      startTickMs, endTickMs, stepMs, stepSec, maxQueued,
      lastGoodTickMs,
      lastGoodRatePps: lastGoodTickMs > 0 ? +(1000 / lastGoodTickMs).toFixed(1) : 0,
      connIntervalMs: connInfoEnd.intervalMs,
      connLatency: connInfoEnd.latency,
      supervisionTimeoutMs: connInfoEnd.supervisionTimeoutMs,
      stoppedReason, steps,
    };
    console.log(`[Bench] Done — lägsta stabila tick = ${lastGoodTickMs}ms (${_benchLastResult.lastGoodRatePps} pps) connInterval=${connInfoEnd.intervalMs}ms — ${stoppedReason}`);
    res.json(_benchLastResult);
  });

  app.get('/api/ble/bench', (_req, res) => {
    res.json({ running: _benchRunning, lastResult: _benchLastResult });
  });

  // --- BLE connection params (live från noble) ---
  // Visar faktisk negotiated connection interval / latency / supervision timeout.
  // Om intervalMs är null = vi kunde inte introspekta noble's HCI-conn.
  // Om intervalMs ≥ 30ms = controllern föll tillbaka till default → BLE-länken
  // är långsam oavsett vad vi skickar i HCI-tweaks.
  app.get('/api/ble/conn-params', async (_req, res) => {
    try {
      const { getNoble } = await import('./ble-driver/noble-singleton.js');
      const { getAttachedHandle, isControllerDrainAttached } = await import('./ble-driver/controllerDrain.js');
      const handle = getAttachedHandle();
      const noble: any = getNoble();
      if (handle == null) {
        return res.json({ ok: false, attached: isControllerDrainAttached(), handle: null, error: 'no handle' });
      }
      const hci = noble?._bindings?._hci;
      const conn = hci?._aclConnections?.get?.(handle) ?? hci?._handles?.[handle];
      if (!conn) {
        return res.json({ ok: false, attached: true, handle, error: 'no conn object', hciKeys: hci ? Object.keys(hci).slice(0, 20) : [] });
      }
      const interval = conn.interval ?? conn.connInterval ?? null;
      const latency  = conn.latency  ?? conn.connLatency  ?? null;
      const sup      = conn.supervisionTimeout ?? conn.timeout ?? null;
      res.json({
        ok: true,
        attached: true,
        handle,
        intervalUnits: interval,
        intervalMs: typeof interval === 'number' ? +(interval * 1.25).toFixed(2) : null,
        latency,
        supervisionTimeoutUnits: sup,
        supervisionTimeoutMs: typeof sup === 'number' ? sup * 10 : null,
        connKeys: Object.keys(conn),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
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
        chosenSlotLeaseMs: lowestSafe,
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
  let _lastTickAbortBleBusy = 0;
  let _lastTickSkippedBleBusy = 0;

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
      const { bleStats } = await import('./ble-driver/state.js');

      const now = performance.now();
      const dt = _lastSampleTs > 0 ? (now - _lastSampleTs) / 1000 : 0;
      const perSec = (cur: number, prev: number) => dt > 0 ? Math.round((cur - prev) / dt) : 0;

      const sentPerSec = perSec(bleStats.sentCount, _lastSent);
      
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
      const tickAbortBleBusyPerSec = perSec(bleStats.tickAbortBleBusyCount ?? 0, _lastTickAbortBleBusy);
      const tickSkippedBleBusyPerSec = perSec(bleStats.tickSkippedBleBusyCount ?? 0, _lastTickSkippedBleBusy);

      const fftFrames = mic.getFFTFrameCount?.() ?? 0;
      const tickCount = engine?.getDiagnostics().tickCount ?? 0;
      const fftPerSec = perSec(fftFrames, _lastFftFrames);
      const tickPerSec = perSec(tickCount, _lastTickCount);

      const writeLatMaxMs = bleStats.writeLatMaxMs ?? 0;
      bleStats.writeLatMaxMs = 0;

      _lastSampleTs = now;
      _lastSent = bleStats.sentCount;
      
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
      _lastTickAbortBleBusy = bleStats.tickAbortBleBusyCount ?? 0;
      _lastTickSkippedBleBusy = bleStats.tickSkippedBleBusyCount ?? 0;

      ble = {
        sentPerSec, skipBusyPerSec, skipInFlightPerSec,
        skipRateLimitPerSec, fftDroppedPerSec, writeFailPerSec, writeStuckPerSec,
        writeLatAvgMs: bleStats.writeLatAvgMs,
        writeLatMaxMs,
        fftPerSec, tickPerSec,
        tickOkPerSec, tickAbortNoMicPerSec, tickAbortNoChangePerSec, tickAbortNoDevicePerSec,
        tickAbortBleBusyPerSec, tickSkippedBleBusyPerSec,
        dropCount: bleStats.dropCount ?? 0,
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
  app.get('/api/ble/output', async (_req, res) => {
    const engine = getEngine();
    if (!engine) {
      res.json({ active: false, r: 0, g: 0, b: 0, brightness: 0, sentCount: 0 });
      return;
    }
    const d = engine.getDiagnostics();
    // Läs drain LIVE direkt från noble — bleStats.controllerOutstandingCount
    // skrivs bara i leaseAndDrainState() och blir stale om engine pausar
    // sendToBLE-anrop (idle/keep-alive). UI ska visa sanningen just nu.
    let liveOutstanding = 0;
    let liveQueued = 0;
    try {
      const cd = await import('./ble-driver/controllerDrain.js');
      if (cd.isControllerDrainAttached()) {
        liveOutstanding = cd.getOutstandingPackets();
        liveQueued = cd.getQueuedPackets();
      }
    } catch {}
    res.json({
      active: true,
      r: d.finalR,
      g: d.finalG,
      b: d.finalB,
      brightness: d.brightnessPct,
      sentCount: bleStats.sentCount,
      
      skipBusyCount: bleStats.skipBusyCount,
      skipLeaseLockedCount: bleStats.skipLeaseLockedCount ?? 0,
      skipControllerBusyCount: bleStats.skipControllerBusyCount ?? 0,
      controllerCompleteCount: bleStats.controllerCompleteCount ?? 0,
      controllerStuckCount: bleStats.controllerStuckCount ?? 0,
      controllerOutstandingCount: liveOutstanding,
      controllerQueuedCount: liveQueued,
      outstandingAgeMs: bleStats.outstandingAgeMs ?? 0,
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

  // --- Record / Playback BORTTAGET (2026-06-02) ---
  // Inspelning/offline-playback och låt-studio är helt borttagna (2026-06-03).





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

  // --- BLE Fade Test borttaget 2026-04-21 ---
  // sendRawColor + fade-test endpoints raderade när BLE-arkitekturen reducerades
  // till två vägar (idle keep-alive + active sendToBLE). Test-verktyget användes
  // bara i dev/benchmark — inte i normal drift.

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
