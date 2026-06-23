#!/usr/bin/env node
/**
 * Lotus Light Link — Headless Pi runtime (lazy-subsystem variant).
 *
 * Boot startar BARA configServer. Inga native-bindningar, inga subsystem
 * laddas förrän användaren explicit triggar dem:
 *   - BLE-motor:  POST /api/ble/engine/start (engine-start-minimal.ts)
 *   - Lampa:      POST /api/ble/connect      (connect-hardcoded.ts)
 *   - Mic:        POST /api/subsystem/mic/start
 *   - Sonos:      POST /api/subsystem/sonos/start
 */

import { installLocalStorageShim } from './storage.js';
installLocalStorageShim();

import { logDebugBanner } from './debugLog.js';
logDebugBanner();

import { getItem, setItem } from './storage.js';
import {
  markSubsystemStarting, markSubsystemReady, markSubsystemError,
  getSubsystemState, type SubsystemId,
} from './ble/subsystem-state.js';

// Applicera ev. tidigare vald BLE-lampa (annars seed:a BLEDOM01 default).
// Måste ske före första connect så connect.ts läser rätt target.
void (async () => {
  try {
    const savedDevice = getItem('lamp-device');
    if (savedDevice) {
      const d = JSON.parse(savedDevice);
      if (d?.name && d?.mac) {
        const { setDeviceConfig } = await import('./ble-driver/device-config.js');
        setDeviceConfig({ name: d.name, mac: d.mac });
        console.log(`[boot] BLE-lampa från sparat val: ${d.name} (${d.mac})`);
      }
    } else {
      const defaultDevice = { name: 'ELK-BLEDOM01', mac: 'BE:67:00:15:09:41' };
      setItem('lamp-device', JSON.stringify(defaultDevice));
      const { setDeviceConfig } = await import('./ble-driver/device-config.js');
      setDeviceConfig(defaultDevice);
      console.log(`[boot] BLE-lampa default seedad: ${defaultDevice.name} (${defaultDevice.mac})`);
    }
  } catch {}
})();
// lightRecorder borttaget (2026-06-02): inspelning/offline-playback avvecklad, allt körs realtime.

// --- Config ---
const SONOS_BUDDY_API_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:3053/api';
const LEGACY_LOCAL_SONOS_URLS = new Set([
  'http://172.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3003/api/sonos',
  'http://127.0.0.1:3002/api/sonos',
  'http://127.0.0.1:3053/api/sonos',
  'http://127.0.0.1:3052/api/sonos',
]);
// PCC sätter PORT direkt på engine. Fallback: räkna från UI_PORT + 50
// (samma offset som services.json portOffset). Sista fallback: 3050.
const CONFIG_PORT = Number(
  process.env.PORT ??
  process.env.ENGINE_PORT ??
  process.env.BACKEND_PORT ??
  (process.env.UI_PORT ? Number(process.env.UI_PORT) + 50 : null) ??
  3050
);
const SSE_PATH = process.env.SSE_PATH ?? '/events';
const STATUS_PATH = process.env.STATUS_PATH ?? '/status';
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const DISABLE_SSE = process.env.DISABLE_SSE === 'true';
const TICK_MS = 25;   // 40 Hz — tätare, mjukare uppdatering. BLE-länken hinner
                      // med utan kö (verifierat live: queued=0, skipBusy=0,
                      // outstanding max 5 av tak 6).

// --- Lazy module references (filled by starters) ---
type AlsaMicModule = typeof import('./alsaMic.js');
type SonosModule = typeof import('./sonosPoller.js');
type EngineModule = typeof import('./piEngine.js');

let alsaMic: AlsaMicModule | null = null;
let sonos: SonosModule | null = null;
let engineMod: EngineModule | null = null;
let engineInstance: import('./piEngine.js').PiLightEngine | null = null;
let configServer: typeof import('./configServer.js') | null = null;

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
}, lastArtUrlRef?: { current: string | null }, wasTvModeRef?: { current: boolean }, lastPaletteSigRef?: { current: string | null }): void {
  if (!engineInstance) return;

  // OBS: engine.setPlaying(...) styrs nu UTESLUTANDE av engineLifecycle.ts.
  // Här uppdaterar vi enbart palette/volym/TV-mode-side-effects.
  if (state.isTvMode) {
    if (wasTvModeRef && !wasTvModeRef.current) {
      console.log('[Engine] → TV-läge (soft)');
      engineInstance.setTvSoft?.(true);
      wasTvModeRef.current = true;
    }
  } else if (wasTvModeRef?.current) {
    console.log('[Engine] TV-läge → Normal');
    engineInstance.setTvSoft?.(false);
    wasTvModeRef.current = false;
  }

  if (state.volume != null) {
    engineInstance.setVolume(state.volume);
    alsaMic?.setAutoGainFromVolume(state.volume);
  }

  if (!state.isTvMode) {
    const artChanged = !!lastArtUrlRef && state.albumArtUrl !== lastArtUrlRef.current;
    if (artChanged) {
      if (lastArtUrlRef) lastArtUrlRef.current = state.albumArtUrl;
      if (lastPaletteSigRef) lastPaletteSigRef.current = null;
      engineInstance.setPalette([]);
      console.log('[Color] Track changed → cleared engine palette, awaiting new from gateway');
    }

    if (state.palette && state.palette.length > 0) {
      const paletteSig = state.palette.map(c => c.join(',')).join('|');
      const paletteChanged = !lastPaletteSigRef || paletteSig !== lastPaletteSigRef.current;
      if (paletteChanged) {
        if (lastPaletteSigRef) lastPaletteSigRef.current = paletteSig;
        engineInstance.setColor(state.palette[0]);
        engineInstance.setPalette(state.palette);
        console.log(`[Color] Palette from gateway: ${state.palette.map(c => `rgb(${c})`).join(', ')}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eager engine init — körs vid boot (FÖRE ignite()) så att lifecycle.toMotorOn()
// kan kalla engineInstance.setPlaying(true) omedelbart utan att vänta på att
// startMicSubsystem skapar engine. Engine.start() körs fortfarande först när
// mic startas (tickInner kräver mic-frames för att göra något meningsfullt).
// ─────────────────────────────────────────────────────────────────────────────
async function ensureEngineInstance(): Promise<void> {
  if (engineInstance) return;
  engineMod = await import('./piEngine.js');
  const savedTickMs = getItem('tick-ms');
  const tick = savedTickMs ? Math.max(5, Math.min(50, Number(savedTickMs))) : TICK_MS;
  engineInstance = new engineMod.PiLightEngine(tick);
  



  const setCb = (globalThis as any).__lotusSetEngineCb;
  if (typeof setCb === 'function') {
    setCb(
      () => engineInstance?.onBleConnected(),
      () => engineInstance?.onBleDisconnected(),
    );
  } else {
    const { setEngineBleCallbacks } = await import('./ble-driver/connect.js');
    setEngineBleCallbacks(
      () => engineInstance?.onBleConnected(),
      () => engineInstance?.onBleDisconnected(),
    );
  }

  try {
    const savedGamma = getItem('dimming-gamma');
    if (savedGamma) {
      const g = parseFloat(savedGamma);
      if (g >= 1 && g <= 3) {
        const { setDimmingGamma } = await import('./ble/index.js');
        setDimmingGamma(g);
      }
    }
  } catch {}
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

      await ensureEngineInstance();

      try {
        const saved = getItem('gain-cal-points');
        if (saved) {
          const { point1, point2 } = JSON.parse(saved);
          alsaMic.setGainCalPoints(point1 ?? null, point2 ?? null);
        }
      } catch {}

      const eng = engineInstance!;
      configServer?.attachConfigRuntime?.({
        engine: eng,
        mic: alsaMic,
        invalidateIdleColorCache: engineMod?.invalidateIdleColorCache,
      });

      alsaMic.startMic();
      eng.start();
      try {
        await alsaMic.waitForFirstAudio(3000);
      } catch (e: any) {
        try { eng.stop(); } catch {}
        try { alsaMic.stopMic(); } catch {}
        throw e;
      }

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

      const lastArtUrl = { current: null as string | null };
      const wasTvMode = { current: false };
      const lastPaletteSig = { current: null as string | null };
      // await så fresh-status race (≤1500ms) hinner trigga setPlaying(true)
      // FÖRE markSubsystemReady — annars kan engine starta i paused-state
      // även om Sonos redan spelar.
      await sonos.onSonosChange((state) => {
        applySonosStateToEngine(state, lastArtUrl, wasTvMode, lastPaletteSig);
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
async function logRuntimePermissions(): Promise<void> {
  try {
    const fs = await import('node:fs');
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    const groups = process.getgroups?.() ?? [];
    console.log(`[Boot/Perms] uid=${uid} gid=${gid} supplementary-gids=[${groups.join(',')}]`);

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('id', ['-Gn']);
      console.log(`[Boot/Perms] groups: ${stdout.trim()}`);
    } catch {}

    try {
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const capLines = status.split('\n').filter(l => l.startsWith('Cap'));
      for (const line of capLines) console.log(`[Boot/Perms] ${line}`);
    } catch {}

    try {
      fs.accessSync('/dev/rfkill', fs.constants.R_OK | fs.constants.W_OK);
      console.log('[Boot/Perms] /dev/rfkill: read+write OK ✓');
    } catch (e: any) {
      console.warn(`[Boot/Perms] /dev/rfkill: NO ACCESS (${e?.code}) — netdev-grupp saknas i processen`);
    }
  } catch (e: any) {
    console.warn('[Boot/Perms] kunde inte logga runtime permissions:', e?.message ?? e);
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Lotus Light Link — Pi Headless Runtime  ║');
  console.log('║   (lazy-subsystem variant)                ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  Config API: :${CONFIG_PORT}`);
  console.log(`  Bridge: ${SONOS_BUDDY_API_URL}`);
  console.log('');

  await logRuntimePermissions();

  console.log('');
  console.log('  Tändning aktiv vid boot — Sonos PLAYING startar motorn automatiskt.');
  console.log('  Manuella override-endpoints (UI):');
  console.log('    BLE-motor:  POST /api/ble/engine/start');
  console.log('    Lampa:      POST /api/ble/connect / disconnect');
  console.log('    Mic/Sonos:  POST /api/subsystem/<mic|sonos>/start');
  console.log('    Lifecycle:  POST /api/lifecycle/override { off: true|false }');

  configServer = await import('./configServer.js');
  configServer.startConfigServer(CONFIG_PORT);
  configServer.attachSubsystemStarters({
    startMic: startMicSubsystem,
    startSonos: startSonosSubsystem,
  });

  console.log('[Boot] ✓ configServer up — ignite() startar BLE-stack + sonos-poller');

  // ── FIX 24: Playback-Watchdog — auto-recover från stuck engine.playing ──
  // Om lifecycle är MOTOR_ON men bleStats.tickOkCount inte växer på 8s →
  // engine sitter i stale state (playing=false eller _bleOwner='idle' trots
  // MOTOR_ON). process.exit(1) → systemd Restart=always gör återställning.
  void (async () => {
    try {
      const { bleStats } = await import('./ble/index.js');
      const lc = await import('./engineLifecycle.js');
      const { scheduleAutoReconnect } = await import('./ble-driver/connect.js');
      const { recordRestart, markGracefulShutdown } = await import('./restartLog.js');
      let lastTickOk = 0;
      let stuckMs = 0;
      let softTried = false;
      const INTERVAL_MS = 2000;
      const STUCK_THRESHOLD_MS = 8000;

      setInterval(() => {
        try {
          if (lc.getLifecycleState() !== 'MOTOR_ON') {
            stuckMs = 0;
            softTried = false;
            lastTickOk = bleStats.tickOkCount;
            return;
          }
          const cur = bleStats.tickOkCount;
          if (cur === lastTickOk) {
            stuckMs += INTERVAL_MS;
            if (stuckMs >= STUCK_THRESHOLD_MS) {
              if (!softTried) {
                // Första frysning → mjuk recovery: försök reconnecta BLE och ge
                // ett nytt fönster innan vi tar till hård restart.
                console.warn(
                  `[Playback-Watchdog] tickOk frozen ${stuckMs}ms while ` +
                  `MOTOR_ON (tickOk=${cur}). Soft recovery: scheduleAutoReconnect().`
                );
                softTried = true;
                stuckMs = 0;
                try { scheduleAutoReconnect(); } catch {}
              } else {
                // Andra frysning trots soft recovery → hård restart via systemd.
                console.error(
                  `[Playback-Watchdog] tickOk still frozen ${stuckMs}ms after ` +
                  `soft recovery (tickOk=${cur}). Exit(1) for systemd restart.`
                );
                try {
                  recordRestart('playback-watchdog-stuck', `tickOk frozen ${stuckMs}ms after soft recovery`);
                  markGracefulShutdown();
                } catch {}
                process.exit(1);
              }
            }
          } else {
            stuckMs = 0;
            softTried = false;
            lastTickOk = cur;
          }
        } catch { /* watchdog must never crash */ }
      }, INTERVAL_MS);
      console.log(`[Boot] Playback-Watchdog active (threshold ${STUCK_THRESHOLD_MS}ms, soft-recovery first)`);
    } catch (e: any) {
      console.warn('[Boot] Playback-Watchdog failed to start:', e?.message ?? e);
    }
  })();

  // ── Restart-log: detektera om förra processen dog ofrivilligt ──
  // noteBootStart() kollar om SESSION_MARKER finns kvar (graceful shutdown
  // skulle ha tagit bort den). Om ja → logga 'unknown-systemd-restart'
  // (täcker OOM-kill, segfault, kill -9 etc) såvida ingen explicit reason
  // redan loggats inom 5s (då har crash-handler eller BLE-fail-path hunnit
  // logga den specifika orsaken).
  const { noteBootStart, markSessionAlive, markGracefulShutdown, recordRestart } =
    await import('./restartLog.js');
  noteBootStart();

  // Wire ble-driverns restart-hook → restart-loggning (drivern är annars
  // fristående och loggar inget). Speglar tidigare inline-logik i connect.ts.
  try {
    const { setRestartHook } = await import('./ble-driver/connect.js');
    setRestartHook(({ count, error }) => {
      recordRestart('ble-consecutive-failures', `${count} consecutive failures, last error: ${error}`);
      markGracefulShutdown();
    });
  } catch (e: any) {
    console.warn('[Boot] kunde inte koppla BLE restart-hook:', e?.message ?? e);
  }

  // ── Auto-restart efter ofrivillig död ────────────────────────────────────
  const {
    consumeReconnectOnBootFlag,
    setReconnectOnBootFlag,
    clearReconnectOnBootFlag,
  } = await import('./ble-driver/reconnect-flag.js');

  // Hook in BLE-callbacks så flaggan sätts när lampa ansluts.
  try {
    const { setEngineBleCallbacks } = await import('./ble-driver/connect.js');
    let engineConnected: (() => void) | null = null;
    let engineDisconnected: (() => void) | null = null;
    setEngineBleCallbacks(
      () => {
        // Sätt flagga + uppdatera session-marker så uptimeBeforeMs blir korrekt
        setReconnectOnBootFlag();
        markSessionAlive();
        engineConnected?.();
      },
      () => { engineDisconnected?.(); },
    );
    (globalThis as any).__lotusSetEngineCb = (onC: () => void, onD: () => void) => {
      engineConnected = onC;
      engineDisconnected = onD;
    };
  } catch (e: any) {
    console.warn('[Boot] kunde inte koppla post-connect flagg-hook:', e?.message ?? e);
  }

  // ── Sonos-driven lifecycle (bil-tändning-modell) ─────────────────────────
  // Ersätter den tidigare /tmp-flagga-baserade auto-restart-pathen.
  // Sonos playbackState är nu källan till sanning för om motorn ska köra.
  // /tmp-flaggan kvarstår som redundant safety net (skrivs av crash-handlers
  // nedan + post-connect-hook ovan) men consumeras inte längre vid boot.
  consumeReconnectOnBootFlag(); // dränera ev. gammal flagga så den inte hänger kvar
  // Eager engine init: skapa engineInstance INNAN ignite() så lifecycle.toMotorOn()
  // kan kalla setPlaying(true) omedelbart utan race mot startMicSubsystem.
  try {
    await ensureEngineInstance();
    console.log('[Boot] ✓ engineInstance skapad eagerly (mic startas vid PLAYING)');
  } catch (e: any) {
    console.warn('[Boot] ensureEngineInstance fel:', e?.message ?? e);
  }

  void (async () => {
    try {
      const { ignite } = await import('./engineLifecycle.js');
      const { startBleEngineMinimal } = await import('./ble/engine-start-minimal.js');
      const { connectHardcoded, getHardcodedConnected } = await import('./ble-driver/connect.js');
      await ignite({
        startBleEngineMinimal,
        startSonosSubsystem,
        startMicSubsystem,
        connectHardcoded: () => connectHardcoded(),
        getHardcodedConnected,
        getEngineInstance: () => engineInstance as any,
        onSonosPlayingChange: async (fn) => {
          if (!sonos) return;
          await sonos.onSonosChange(async (state) => {
            const playing = typeof state.playbackState === 'string'
              && state.playbackState.includes('PLAYING');
            await fn(playing || state.isTvMode);
          });
        },
      });
    } catch (e: any) {
      console.warn('[Boot] ignite() fel:', e?.message ?? e);
    }
  })();

  // Crash-handlers: logga reason, sätt flagga, exit. systemd Restart=always tar oss tillbaka.
  process.on('uncaughtException', (err) => {
    console.error('[Fatal/uncaughtException]', err);
    try {
      recordRestart('uncaught-exception', err?.stack ?? err?.message ?? String(err));
      markGracefulShutdown(); // säg åt nästa boot att INTE logga 'unknown' — vi har loggat reason
    } catch {}
    setReconnectOnBootFlag();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal/unhandledRejection]', reason);
    try {
      const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      recordRestart('unhandled-rejection', detail);
      markGracefulShutdown();
    } catch {}
    setReconnectOnBootFlag();
    process.exit(1);
  });

  // Graceful shutdown — UI eller user-initiated. Rensa flagga + session-marker
  // så nästa boot inte loggar en falsk 'unknown-systemd-restart'.
  const shutdown = async () => {
    console.log('\n[Shutdown] Cleaning up…');
    clearReconnectOnBootFlag();
    markGracefulShutdown();
    try { engineInstance?.stop(); } catch {}
    try { alsaMic?.stopMic(); } catch {}
    try { sonos?.stopSonosPoller(); } catch {}
    try {
      const { disconnectHardcoded } = await import('./ble-driver/connect.js');
      await disconnectHardcoded();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
