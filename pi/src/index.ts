#!/usr/bin/env node
/**
 * Lotus Light Link — Headless Pi runtime (lazy-subsystem variant).
 *
 * Boot startar BARA configServer + heartbeat. Inga native-bindningar,
 * inga subsystem (BLE, mic, sonos) laddas förrän användaren explicit
 * triggar dem via /api/subsystem/<id>/start. Detta:
 *   - eliminerar libuv-racen där alsa-capture åt noble's stateChange-event
 *   - gör boot-tiden konsekvent (ingen 15s noble-vänta)
 *   - matchar mental modell: BLE-motor, lampa, mic och Sonos är separata system
 *
 * Autostart hanteras klient-sidigt: PiMobile pollar localStorage-flaggor och
 * triggar /api/subsystem/<id>/start sekventiellt (väntar på 'ready' innan nästa).
 */

import { installLocalStorageShim } from './storage.js';
installLocalStorageShim();

import { installLogCapture } from './ble/log-buffer.js';
installLogCapture();

import { getItem, setItem } from './storage.js';
import {
  setBootPhase, markSubsystemStarting, markSubsystemReady, markSubsystemError,
  getSubsystemState, type SubsystemId,
} from './ble/state.js';

// --- Config ---
const SONOS_BUDDY_API_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:3053/api';
const LEGACY_LOCAL_SONOS_URLS = new Set([
  'http://172.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3002/api/sonos',
  'http://127.0.0.1:3053/api/sonos',
  'http://127.0.0.1:3052/api/sonos',
]);
const CONFIG_PORT = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3050);
const SSE_PATH = process.env.SSE_PATH ?? '/events';
const STATUS_PATH = process.env.STATUS_PATH ?? '/status';
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const DISABLE_SSE = process.env.DISABLE_SSE === 'true';
const TICK_MS = 40;

// --- Lazy module references (filled by starters) ---
type AlsaMicModule = typeof import('./alsaMic.js');
type NobleBleModule = typeof import('./nobleBle.js');
type SonosModule = typeof import('./sonosPoller.js');
type EngineModule = typeof import('./piEngine.js');

let alsaMic: AlsaMicModule | null = null;
let nobleBle: NobleBleModule | null = null;
let sonos: SonosModule | null = null;
let engineMod: EngineModule | null = null;
let engineInstance: import('./piEngine.js').PiLightEngine | null = null;
let configServer: typeof import('./configServer.js') | null = null;

// --- In-flight guards (don't start the same subsystem twice) ---
const _inflight: Partial<Record<SubsystemId, Promise<void>>> = {};

function normalizeSonosBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/$/, '');
  const base = trimmed.length > 0 ? trimmed : SONOS_BUDDY_API_URL;
  return LEGACY_LOCAL_SONOS_URLS.has(base) ? SONOS_BUDDY_API_URL : base;
}

function applySonosStateToEngine(state: {
  playbackState: string;
  isTvMode: boolean;
  volume: number | null;
  palette: [number, number, number][] | null;
  albumArtUrl: string | null;
}, lastArtUrlRef?: { current: string | null }, wasTvModeRef?: { current: boolean }): void {
  if (!engineInstance) return;
  const isPlaying = state.playbackState === 'PLAYBACK_STATE_PLAYING';

  if (state.isTvMode) {
    engineInstance.setPlaying(true);
    if (wasTvModeRef && !wasTvModeRef.current) {
      console.log('[Engine] → TV-läge');
      wasTvModeRef.current = true;
    }
  } else {
    engineInstance.setPlaying(isPlaying);
    if (wasTvModeRef?.current) {
      console.log('[Engine] TV-läge → Normal');
      wasTvModeRef.current = false;
    }
  }

  if (state.volume != null) {
    engineInstance.setVolume(state.volume);
    alsaMic?.setAutoGainFromVolume(state.volume);
  }

  if (!state.isTvMode && state.palette && state.palette.length > 0) {
    const artChanged = !lastArtUrlRef || state.albumArtUrl !== lastArtUrlRef.current;
    if (artChanged) {
      if (lastArtUrlRef) lastArtUrlRef.current = state.albumArtUrl;
      engineInstance.setColor(state.palette[0]);
      engineInstance.setPalette(state.palette);
      console.log(`[Color] Palette from gateway: ${state.palette.map(c => `rgb(${c})`).join(', ')}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subsystem: BLE-motor (noble + adapter wake-up)
// ─────────────────────────────────────────────────────────────────────────────
async function startBleEngine(): Promise<void> {
  if (_inflight.bleEngine) return _inflight.bleEngine;
  if (getSubsystemState('bleEngine').status === 'ready') return;

  _inflight.bleEngine = (async () => {
    markSubsystemStarting('bleEngine');
    try {
      const { isHci0Up } = await import('./ble/adapter-hci-check.js');
      if (!isHci0Up()) console.log('[Subsystem:bleEngine] hci0 DOWN — kommer aktivera via ensureAdapterUp');

      console.log('[Subsystem:bleEngine] importing nobleBle (triggar noble HCI-init)…');
      nobleBle = await import('./nobleBle.js');
      const { ensureAdapterUp, waitForFirstStateChange, getAdapterState } = nobleBle;

      const { runBleCapsSelfCheck, setHciProbeSnapshot, logConnectionEvent, recordObservedNobleState, getNobleRawState } = await import('./ble/state.js');
      runBleCapsSelfCheck();

      try {
        const probe = (await import('./ble/hci-socket-probe.js')).probeHciSocket();
        setHciProbeSnapshot({ ok: probe.ok, method: probe.method, errno: probe.errno, error: probe.error, details: probe.details });
        if (!probe.ok) console.error(`[Subsystem:bleEngine] HCI probe FAIL: ${probe.error}`);
      } catch (e: any) { console.error('[Subsystem:bleEngine] hci-probe crashed:', e?.message ?? e); }

      try { await ensureAdapterUp(); } catch (e: any) { console.warn('[Subsystem:bleEngine] ensureAdapterUp warning:', e?.message ?? e); }

      // Vänta upp till 10s på noble.poweredOn — men acceptera "effective ready"
      // (caps + hci0 UP) även om raw stannar i unknown.
      const waitStart = Date.now();
      try {
        const result = await Promise.race([
          waitForFirstStateChange(10_000),
          (async () => {
            try { await (nobleBle!.noble as any).waitForPoweredOnAsync(10_000); recordObservedNobleState('poweredOn'); return 'poweredOn'; }
            catch { return 'wait-timeout'; }
          })(),
        ]);
        const raw = getNobleRawState();
        const eff = getAdapterState();
        const sec = Math.round((Date.now() - waitStart) / 1000);
        if (result === 'poweredOn' || raw === 'poweredOn' || eff === 'poweredOn') {
          logConnectionEvent({ type: 'connect_start', detail: `subsystem:bleEngine redo efter ${sec}s (raw=${raw ?? '-'}, eff=${eff ?? '-'})` });
        } else {
          throw new Error(`BLE-motor inte redo efter ${sec}s (raw=${raw ?? '-'}, eff=${eff ?? '-'})`);
        }
      } catch (e: any) {
        markSubsystemError('bleEngine', e?.message ?? String(e));
        throw e;
      }

      // Heartbeat startas nu (en gång) — säker att starta även om subsystem startas om
      const { startBleHeartbeat } = await import('./ble/heartbeat.js');
      startBleHeartbeat();

      // Återställ dimming-gamma (kräver protocol som dras in via nobleBle)
      const savedGamma = getItem('dimming-gamma');
      if (savedGamma) {
        const g = parseFloat(savedGamma);
        if (g >= 1 && g <= 3) nobleBle.setDimmingGamma(g);
      }

      // Återställ BLE write rate-limit (live-tweakbar via /api/ble/rate-limit)
      const savedMinWrite = getItem('ble-min-write-interval-ms');
      if (savedMinWrite) {
        const v = parseFloat(savedMinWrite);
        if (Number.isFinite(v) && v >= 5 && v <= 100) nobleBle.setMinWriteIntervalMs(v);
      }

      setBootPhase('ready');
      markSubsystemReady('bleEngine');

      // Push referenser till configServer om den redan attachat engine
      configServer?.attachConfigRuntime?.({
        engine: engineInstance!,
        mic: alsaMic!,
        invalidateIdleColorCache: engineMod?.invalidateIdleColorCache,
      });
    } catch (e) {
      // markSubsystemError redan satt om vi nådde dit; annars sätt nu
      if (getSubsystemState('bleEngine').status !== 'error') {
        markSubsystemError('bleEngine', (e as any)?.message ?? String(e));
      }
      throw e;
    } finally {
      delete _inflight.bleEngine;
    }
  })();
  return _inflight.bleEngine;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subsystem: Mikrofon (alsa-capture native)
// ─────────────────────────────────────────────────────────────────────────────
async function startMicSubsystem(): Promise<void> {
  if (_inflight.mic) return _inflight.mic;
  if (getSubsystemState('mic').status === 'ready') return;

  _inflight.mic = (async () => {
    markSubsystemStarting('mic');
    try {
      console.log('[Subsystem:mic] importing alsaMic (native ALSA-bindning)…');
      alsaMic = await import('./alsaMic.js');

      const savedAlsaDevice = getItem('alsa-device');
      const savedMicGain = getItem('mic-gain');
      if (savedAlsaDevice) alsaMic.setAlsaDevice(savedAlsaDevice);
      if (savedMicGain) {
        const g = parseFloat(savedMicGain);
        if (g >= 0.1 && g <= 50) alsaMic.setMicGain(g);
      }

      // Skapa engine om den inte finns ännu
      if (!engineInstance) {
        engineMod = await import('./piEngine.js');
        const savedTickMs = getItem('tick-ms');
        const tick = savedTickMs ? Math.max(5, Math.min(50, Number(savedTickMs))) : TICK_MS;
        engineInstance = new engineMod.PiLightEngine(tick);
      }

      // Försök applicera gain-cal från storage
      try {
        const saved = getItem('gain-cal-points');
        if (saved) {
          const { point1, point2 } = JSON.parse(saved);
          alsaMic.setGainCalPoints(point1 ?? null, point2 ?? null);
        }
      } catch {}

      configServer?.attachConfigRuntime?.({
        engine: engineInstance,
        mic: alsaMic,
        invalidateIdleColorCache: engineMod?.invalidateIdleColorCache,
      });

      alsaMic.startMic();
      engineInstance.start();
      // Regressionfix: om Sonos redan startat och redan är PLAYING när mic/engine
      // kommer upp, så måste vi replaya currentState EFTER engine.start().
      // Annars missas första onSonosChange-eventet och engine blir kvar i idle
      // (0% output) tills nästa Sonos-förändring.
      if (sonos?.getSonosState) {
        applySonosStateToEngine(sonos.getSonosState());
      }
      markSubsystemReady('mic');
      markSubsystemReady('engine');
    } catch (e: any) {
      markSubsystemError('mic', e?.message ?? String(e));
      throw e;
    } finally {
      delete _inflight.mic;
    }
  })();
  return _inflight.mic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subsystem: Sonos-poller
// ─────────────────────────────────────────────────────────────────────────────
async function startSonosSubsystem(): Promise<void> {
  if (_inflight.sonos) return _inflight.sonos;
  if (getSubsystemState('sonos').status === 'ready') return;

  _inflight.sonos = (async () => {
    markSubsystemStarting('sonos');
    try {
      console.log('[Subsystem:sonos] importing sonosPoller…');
      sonos = await import('./sonosPoller.js');

      const savedAutoTv = getItem('auto-tv-mode');
      if (savedAutoTv === 'true') sonos.setAutoTvMode(true);

      let baseUrl = SONOS_BUDDY_API_URL;
      try {
        const saved = getItem('sonos-gateway');
        if (saved) {
          const parsed = JSON.parse(saved);
          baseUrl = normalizeSonosBaseUrl(parsed?.baseUrl);
        }
      } catch {}

      const cfg = { baseUrl, ssePath: SSE_PATH, statusPath: STATUS_PATH, pollIntervalMs: POLL_INTERVAL, disableSSE: DISABLE_SSE };
      await sonos.startSonosPoller(cfg);

      // Wire Sonos → engine (om engine redan finns)
      const lastArtUrl = { current: null as string | null };
      const wasTvMode = { current: false };
      sonos.onSonosChange((state) => {
        applySonosStateToEngine(state, lastArtUrl, wasTvMode);
      });

      markSubsystemReady('sonos');
    } catch (e: any) {
      markSubsystemError('sonos', e?.message ?? String(e));
      throw e;
    } finally {
      delete _inflight.sonos;
    }
  })();
  return _inflight.sonos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('║   (lazy-subsystem variant)                ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Config API: :${CONFIG_PORT}`);
  console.log(`  Bridge: ${SONOS_BUDDY_API_URL}`);
  console.log('');
  console.log('  Boot startar INTE BLE/mic/sonos automatiskt.');
  console.log('  Använd UI:t (Subsystem-startup-panelen) eller');
  console.log('  POST /api/subsystem/<bleEngine|mic|sonos>/start');
  console.log('');

  configServer = await import('./configServer.js');
  configServer.startConfigServer(CONFIG_PORT);
  configServer.attachSubsystemStarters({
    startBleEngine,
    startMic: startMicSubsystem,
    startSonos: startSonosSubsystem,
  });

  setBootPhase('idle');
  console.log('[Boot] ✓ configServer up — väntar på subsystem-start från UI/API');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Cleaning up…');
    try { engineInstance?.stop(); } catch {}
    try { alsaMic?.stopMic(); } catch {}
    try { sonos?.stopSonosPoller(); } catch {}
    try { if (nobleBle) await nobleBle.disconnectAll(true); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
