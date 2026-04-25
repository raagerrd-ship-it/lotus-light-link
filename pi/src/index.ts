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

import { getItem } from './storage.js';
import {
  markSubsystemStarting, markSubsystemReady, markSubsystemError,
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
const TICK_MS = 20;

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
  // Acceptera alla PLAYING-varianter (PLAYBACK_STATE_PLAYING, PLAYING, ev.
  // PLAYING_ad). Matchar sonosPoller.isPlaying() och UI:s play-detektion —
  // utan detta visade UI:t play-symbol medan engine satt PAUSED.
  const isPlaying = typeof state.playbackState === 'string'
    && state.playbackState.includes('PLAYING');

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

  if (!state.isTvMode) {
    const artChanged = !!lastArtUrlRef && state.albumArtUrl !== lastArtUrlRef.current;

    // Trackbyte upptäckt → rensa engine-palette OMEDELBART så motorn inte
    // fortsätter välja förra låtens färg medan vi väntar på ny palette från gw.
    // Engine fade:ar då från nuvarande färg mot nästa palette[0] när den landar.
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
// Subsystem: Mikrofon (alsa-capture native) — engine startas implicit här
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

      if (!engineInstance) {
        engineMod = await import('./piEngine.js');
        const savedTickMs = getItem('tick-ms');
        const tick = savedTickMs ? Math.max(5, Math.min(50, Number(savedTickMs))) : TICK_MS;
        engineInstance = new engineMod.PiLightEngine(tick);

        // Koppla BLE connect/disconnect → engine, så keep-alive och idle-heartbeat
        // bara körs när lampan faktiskt är ansluten (inte vid engine.start()).
        const { setEngineBleCallbacks } = await import('./ble/connect-hardcoded.js');
        setEngineBleCallbacks(
          () => engineInstance?.onBleConnected(),
          () => engineInstance?.onBleDisconnected(),
        );

        // Återställ sparad dimming-gamma från storage. Utan detta hamnar engine
        // alltid på default 1.0 efter omstart, oavsett vad användaren sparat —
        // vilket gör att brightness-kurvan blir fel tills profil sparas igen.
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
      try {
        await alsaMic.waitForFirstAudio(3000);
      } catch (e: any) {
        try { engineInstance.stop(); } catch {}
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
      sonos.onSonosChange((state) => {
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
  console.log('  Boot startar INTE BLE/mic/sonos automatiskt.');
  console.log('  BLE-motor:  POST /api/ble/engine/start');
  console.log('  Lampa:      POST /api/ble/connect');
  console.log('  Mic/Sonos:  POST /api/subsystem/<mic|sonos>/start');
  console.log('');

  configServer = await import('./configServer.js');
  configServer.startConfigServer(CONFIG_PORT);
  configServer.attachSubsystemStarters({
    startMic: startMicSubsystem,
    startSonos: startSonosSubsystem,
  });

  console.log('[Boot] ✓ configServer up — väntar på subsystem-start från UI/API');

  // Auto-reconnect efter self-restart: om förra processen dog pga consecutive
  // BLE-failures finns en flagga i /tmp. Konsumera den och starta motor + connect
  // direkt så användaren slipper trycka knappar manuellt efter en restart-cykel.
  try {
    const { consumeReconnectOnBootFlag } = await import('./ble/reconnect-flag.js');
    if (consumeReconnectOnBootFlag()) {
      console.log('[Boot] 🔁 reconnect-flagga hittad → startar BLE-motor + connectHardcoded()');
      // Starta engine först (så noble laddas), sen connect.
      const { startBleEngineMinimal } = await import('./ble/engine-start-minimal.js');
      await startBleEngineMinimal().catch((e: any) => console.warn('[Boot] startBleEngineMinimal fel:', e?.message ?? e));
      const { connectHardcoded } = await import('./ble/connect-hardcoded.js');
      // Liten delay så noble hinner till poweredOn innan första scan.
      setTimeout(() => {
        connectHardcoded().then((r) => {
          console.log(`[Boot] auto-reconnect resultat: connected=${r.connected} ${r.error ? `error=${r.error}` : ''} (${r.durationMs}ms)`);
        }).catch((e: any) => console.warn('[Boot] auto-reconnect kastade:', e?.message ?? e));
      }, 1500);
    }
  } catch (e: any) {
    console.warn('[Boot] reconnect-flagga-check fel:', e?.message ?? e);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Cleaning up…');
    try { engineInstance?.stop(); } catch {}
    try { alsaMic?.stopMic(); } catch {}
    try { sonos?.stopSonosPoller(); } catch {}
    try {
      const { disconnectHardcoded } = await import('./ble/connect-hardcoded.js');
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
