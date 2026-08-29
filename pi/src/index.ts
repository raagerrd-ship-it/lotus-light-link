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

// B2: minimal crash-handler REDAN här. main() installerar de fullständiga
// (med restart-logg) långt senare — en krasch under boot-importerna lämnade
// tidigare bara ett tomt systemd-exit utan reason.
const bootCrash = (tag: string) => (e: unknown) => {
  console.error(`[Fatal/boot:${tag}]`, e);
  process.exit(1);
};
const _bootUncaught = bootCrash('uncaughtException');
const _bootRejection = bootCrash('unhandledRejection');
process.once('uncaughtException', _bootUncaught);
process.once('unhandledRejection', _bootRejection);

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
const TICK_MS = 10;   // 100 Hz — EN tick för hela compute-kedjan (samma takt som
                      // FFT:n). tickInner körs på varje FFT-frame; BLE-leveransen
                      // är frikopplad via 1-plats-slot (senaste vinner).

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

// A3: EN onSonosChange-prenumeration (registreras i startSonosSubsystem).
// Lifecycle registrerar sin playing-handler via ignite-dep:n och får senast
// kända state replay:at direkt. Två prenumerationer = två boot-fetches, eftersom
// onSonosChange gör en färsk fetchStatusOnce per registrering.
let _sonosPlayingHandler: ((playing: boolean) => Promise<void> | void) | null = null;
let _lastSonosPlaying: boolean | null = null;

function normalizeSonosBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/$/, '');
  const base = trimmed.length > 0 ? trimmed : SONOS_BUDDY_API_URL;
  return LEGACY_LOCAL_SONOS_URLS.has(base) ? SONOS_BUDDY_API_URL : base;
}

// Profiler BORTTAGNA (2026-08-25): EN global inställnings-uppsättning.
// TV-läge loggas men byter inte längre kalibrering.

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
      console.log('[Engine] → TV-läge');
      wasTvModeRef.current = true;
    }
  } else if (wasTvModeRef?.current) {
    console.log('[Engine] TV-läge → Normal');
    wasTvModeRef.current = false;
  }

  // FIX 4: lärd volym→gain lär BARA när musik spelar och inte i TV-läge
  // (icke-normaliserat TV-ljud skulle korrumpera per-volym-inlärningen).
  const isPlaying = state.playbackState.includes('PLAYING');
  alsaMic?.setGainLearnGate?.(isPlaying, state.isTvMode);
  alsaMic?.setMicPlaybackGate?.(isPlaying);

  if (state.volume != null) {
    engineInstance.setVolume(state.volume);
    // Gain-kurvan är alltid aktiv (2026-08-23) — inget auto-läge att slå på.
    // 2026-07-22: aktivera auto-gain automatiskt första gången vi ser
    // en Sonos-volym — annars måste user gå in i UI:t på fresh install.
    // Respekterar explicit user-override: har användaren stängt av auto-gain
    // via PUT /api/auto-gain {enabled:false} slår den aldrig på sig själv igen.
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
  // Compute-ticken är låst till FFT-takten (TICK_MS). Ett gammalt sparat
  // tick-ms (t.ex. 25 från nedsamplings-eran) får inte sätta smoothing-basen.
  const savedTickMs = Number(getItem('tick-ms'));
  const tick = savedTickMs >= 5 && savedTickMs <= TICK_MS ? savedTickMs : TICK_MS;
  engineInstance = new engineMod.PiLightEngine(tick);
  



  // Additiv registrering (listener-lista i connect.ts) — main:s hook
  // läggs till separat, ingen globalThis-indirektion behövs.
  const { setEngineBleCallbacks } = await import('./ble-driver/connect.js');
  setEngineBleCallbacks(
    () => engineInstance?.onBleConnected(),
    () => engineInstance?.onBleDisconnected(),
  );

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
      

      // A2: gain + cal-punkter laddas ENBART av alsaMic (mic-state.json). Att
      // läsa legacy-nycklarna här skrev över nyss auto-kalibrerade värden.
      const savedAlsaDevice = getItem('alsa-device');
      if (savedAlsaDevice) alsaMic.setAlsaDevice(savedAlsaDevice);

      await ensureEngineInstance();

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
      // ── Låtbyte → hint till beat-trackern ──
      // Gatewayen kan glitcha trackName (tom sträng mitt i en låt, dubbel-event),
      // så bytet debouncas ~1.5 s innan motorn får sin hint. Hinten är mjuk:
      // tempot behålls som startgissning, sökningen vidgas tillfälligt.
      let lastTrackName: string | null = null;
      let trackDebounce: NodeJS.Timeout | null = null;
      const noteTrackName = (name: string | null) => {
        if (name === lastTrackName) return;
        lastTrackName = name;
        if (trackDebounce) clearTimeout(trackDebounce);
        if (!name) return;                       // TV/tomt namn är inget låtbyte
        trackDebounce = setTimeout(() => {
          trackDebounce = null;
          if (name !== lastTrackName) return;    // hann ändras igen → glitch
          engineInstance?.notifyTrackChange();
        }, 1500);
      };
      // await så fresh-status race (≤1500ms) hinner trigga setPlaying(true)
      // FÖRE markSubsystemReady — annars kan engine starta i paused-state
      // även om Sonos redan spelar.
      // EN prenumeration (A3): dispatchar till både engine-side-effects och
      // lifecycle:s playing-handler.
      await sonos.onSonosChange((state) => {
        applySonosStateToEngine(state, lastArtUrl, wasTvMode, lastPaletteSig);
        noteTrackName(state.trackName ?? null);
        // TV-läge håller motorn IGÅNG så den reaktiva TV-profilen tickar.
        // Idle gäller enbart äkta "spelar inte".
        const playing = typeof state.playbackState === 'string'
          && state.playbackState.includes('PLAYING');
        _lastSonosPlaying = playing;
        void _sonosPlayingHandler?.(playing);
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

  // (Playback-watchdog registreras EN gång längre ner — se FIX 24. Den tidigare
  //  duplicerade kopian här togs bort 2026-08-20: två 2s-timers med samma
  //  ansvar gav dubbla wakeups och risk för dubbel exit(1).)


  console.log('[Boot] ✓ configServer up — ignite() startar BLE-stack + sonos-poller');

  // ── Gemensam 1 Hz-scheduler (2026-08-20) ────────────────────────────────
  // Varje fristående setInterval är en egen timer-wakeup som konkurrerar med
  // tick-loopen på Zero 2W:s svaga kärnor. Watchdog (2s) och spotify-poll (5s)
  // körs nu från EN 1 Hz-timer med räknare istället för två egna timers.
  const secTasks: Array<{ everySec: number; fn: () => void; n: number }> = [];
  function everySeconds(everySec: number, fn: () => void): void {
    secTasks.push({ everySec, fn, n: 0 });
  }
  setInterval(() => {
    for (const t of secTasks) {
      if (++t.n < t.everySec) continue;
      t.n = 0;
      try { t.fn(); } catch { /* en task får aldrig döda schedulern */ }
    }
  }, 1000);

  // Runtime-hälsa (event-loop-lag, tick-jitter, FFT-fps) — samplas av samma timer.
  {
    const { sample } = await import('./runtimeHealth.js');
    everySeconds(1, () => {
      let fftCount = 0;
      try { fftCount = alsaMic?.getFFTFrameCount?.() ?? 0; } catch {}
      sample(fftCount);
    });
  }

  // FIX 4: lärd volym→gain förfinas långsamt (~minuter) → följ den även utan
  // volymbyte. Ändringstakten är omärkbar inom en låt.
  everySeconds(1, () => { alsaMic?.refreshAutoGain?.(); });

  // ── BLE-down-larm (FIX 8): när BLE tappas under MOTOR_ON fryser ljus-pipelinen
  // tyst — micen är frisk så ingen befintlig watchdog ser det. Larma EN gång per
  // nedtid. Ingen omstart utlöses; recordRestart används som händelselogg.
  {
    const { getHardcodedConnected } = await import('./ble/index.js');
    const lc = await import('./engineLifecycle.js');
    const { recordRestart } = await import('./restartLog.js');
    const { setBleDownForMs } = await import('./runtimeHealth.js');
    const ALARM_AFTER_MS = 15000;
    let downSinceMs = 0;
    let alarmed = false;
    everySeconds(1, () => {
      if (lc.getLifecycleState() !== 'MOTOR_ON' || getHardcodedConnected().connected) {
        downSinceMs = 0; alarmed = false; setBleDownForMs(0);
        return;
      }
      if (!downSinceMs) downSinceMs = Date.now();
      const downMs = Date.now() - downSinceMs;
      setBleDownForMs(downMs);
      if (!alarmed && downMs >= ALARM_AFTER_MS) {
        alarmed = true;
        console.error(`[BLE-Down] ljuset fryst ${downMs}ms — BLE ej ansluten under MOTOR_ON`);
        try { recordRestart('ble-down-light-frozen', `BLE nere ${downMs}ms under MOTOR_ON (ingen omstart)`); } catch {}
      }
    });
  }





  // ── Playback-Watchdog — analys-tick, inte BLE-delivery ──
  // 2026-08-25: BLE-leverans är asynkron 1-slot. Watchdogen får därför ALDRIG
  // hard-restarta för ren delivery-stall; den tittar på engineTickTotal. BLE får
  // hacka/droppa frames under WiFi-contention, men analys-ticken ska fortsätta.
  void (async () => {
    try {
      const { bleStats } = await import('./ble/index.js');
      const lc = await import('./engineLifecycle.js');
      const { getWriteDiag } = await import('./ble-driver/protocol.js');
      const { recordRestart, markGracefulShutdown } = await import('./restartLog.js');
      const { getRuntimeHealth, msSinceLastTick, getEngineTickTotal } = await import('./runtimeHealth.js');

      let lastEngineTicks = 0;
      let lastAudioCbs = 0;
      let stuckMs = 0;
      let recoveryAttempts = 0;
      const INTERVAL_MS = 2000;
      const STUCK_THRESHOLD_MS = 8000;
      const MAX_RECOVERY_ATTEMPTS = 3;

      everySeconds(INTERVAL_MS / 1000, () => {
        try {
          // Mic-stall fångas direkt, oberoende av lifecycle: utan audio-callbacks
          // finns ingen FFT och därmed ingen tick alls.
          if (alsaMic?.isMicStalled?.()) {
            alsaMic.restartCapture('mic-stall-watchdog');
          }

          if (lc.getLifecycleState() !== 'MOTOR_ON') {
            stuckMs = 0;
            recoveryAttempts = 0;
            lastEngineTicks = getEngineTickTotal();
            lastAudioCbs = alsaMic?.getAudioCbStats?.().count ?? 0;
            return;
          }

          const curTickOk = bleStats.tickOkCount;
          const curEngineTicks = getEngineTickTotal();
          const curAudioCbs = alsaMic?.getAudioCbStats?.().count ?? 0;

          if (curEngineTicks !== lastEngineTicks) {
            stuckMs = 0;
            recoveryAttempts = 0;
            lastEngineTicks = curEngineTicks;
            lastAudioCbs = curAudioCbs;
            return;
          }

          stuckMs += INTERVAL_MS;
          if (stuckMs < STUCK_THRESHOLD_MS) return;

          // ── Frys-dump: säger definitivt vilket delsystem som står still ──
          const micFrozen = curAudioCbs === lastAudioCbs;
          const engineFrozen = curEngineTicks === lastEngineTicks;
          const wd = getWriteDiag();
          const rh = getRuntimeHealth();
          console.warn(
            `[Playback-Watchdog] FROZEN ${stuckMs}ms — tickOk=${curTickOk} ` +
            `engineTicks=${curEngineTicks} (${engineFrozen ? 'frozen' : 'running'}) ` +
            `audioCbs=${curAudioCbs} (${micFrozen ? 'frozen' : 'running'}) ` +
            `lastTickAge=${Math.round(msSinceLastTick())}ms ` +
            `writePending=${wd.writePending} pendingAge=${wd.pendingAgeMs}ms ` +
            `lastWriteAge=${wd.lastWriteAgeMs}ms slotLocked=${wd.slotLockedForMs}ms ` +
            `writeStallReleases=${bleStats.writeStallReleaseCount} ` +
            `writeSyncMax=${bleStats.writeSyncMaxMs}ms ` +
            `writeSyncSlow=${bleStats.writeSyncSlowCount} ` +
            `controllerStuck=${bleStats.controllerStuckCount} ` +
            `maxNativeCall=${rh.maxNativeCallMs}ms ` +
            `slowNative=${rh.slowNativeCallTotal}` +
            (rh.lastSlowNativeCall ? ` last=${rh.lastSlowNativeCall.op}/${rh.lastSlowNativeCall.ms}ms` : '')
          );

          recoveryAttempts++;
          if (recoveryAttempts <= MAX_RECOVERY_ATTEMPTS) {
            // Riktad soft recovery — återställ analyskedjan, aldrig BLE-delivery.
            if (micFrozen) {
              console.warn(`[Playback-Watchdog] soft recovery ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}: mic-capture restart`);
              alsaMic?.restartCapture?.('playback-watchdog');
            } else {
              console.warn(`[Playback-Watchdog] soft recovery ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}: engine tick scheduler restart`);
              try { engineInstance?.restartTimer?.(); } catch {}
            }
            stuckMs = 0;
            lastEngineTicks = curEngineTicks;
            lastAudioCbs = curAudioCbs;
            return;
          }

          // Alla riktade försök misslyckades → hård restart via systemd.
          const reason = micFrozen ? 'mic-capture' : 'engine-tick';
          console.error(
            `[Playback-Watchdog] engine tick still frozen after ${MAX_RECOVERY_ATTEMPTS} ` +
            `soft recoveries (${reason}). Exit(1) for systemd restart.`
          );
          try {
            recordRestart('playback-watchdog-stuck', `engineTick frozen ${stuckMs}ms, ${reason}, after ${MAX_RECOVERY_ATTEMPTS} soft recoveries`);
            markGracefulShutdown();
          } catch {}
          process.exit(1);
        } catch { /* watchdog must never crash */ }
      });
      console.log(`[Boot] Playback-Watchdog active (threshold ${STUCK_THRESHOLD_MS}ms, ${MAX_RECOVERY_ATTEMPTS} targeted soft recoveries first)`);

      // ── Content-Freeze-watchdog: tyst I2S-DMA-wedge matar byte-identisk buffert.
      // Tiered + tmpfs-spärr så en wedge som kräver reboot inte blir restart-loop.
      {
        const fs = await import('node:fs');
        const FREEZE_FILE = '/tmp/lotus-mic-freeze-restart-at';
        const CONTENT_FREEZE_MS = 4000;      // 4s byte-identiskt = otvetydig wedge
        const STABLE_CONTENT_FREEZE_MS = 15000; // heuristisk (EMA) → längre fönster
        const RESTART_SUPPRESS_MS = 120000;  // rensade ej reopen+restart det <2min sen → churna inte
        let contentSteps = 0;
        everySeconds(2, () => {
          try {
            if (lc.getLifecycleState() !== 'MOTOR_ON') { contentSteps = 0; return; }
            const frozenMs = alsaMic?.getMicContentFrozenMs?.() ?? 0;
            const stableFrozenMs = alsaMic?.getMicStableContentFrozenMs?.() ?? 0;
            const hardFreezeMs = frozenMs >= CONTENT_FREEZE_MS ? frozenMs : 0;
            const freezeMs = Math.max(hardFreezeMs,
              stableFrozenMs >= STABLE_CONTENT_FREEZE_MS ? stableFrozenMs : 0);
            if (freezeMs === 0) { contentSteps = 0; return; }
            contentSteps++;
            console.warn(`[Content-Freeze] mic-innehåll fruset ${freezeMs}ms — steg ${contentSteps}`);
            if (contentSteps === 1) {
              alsaMic?.restartCapture?.('content-freeze');       // steg 1: reopen ALSA (rör ej BLE)
            } else if (contentSteps >= 3 && hardFreezeMs > 0) {   // process-restart BARA på byte-identisk wedge

              let lastRestart = 0;
              try { lastRestart = Number(fs.readFileSync(FREEZE_FILE, 'utf8')) || 0; } catch {}
              const since = lastRestart ? (Date.now() - lastRestart) : Infinity;
              if (since > RESTART_SUPPRESS_MS) {
                try { fs.writeFileSync(FREEZE_FILE, String(Date.now())); } catch {}
                recordRestart('mic-content-freeze', `frozen ${freezeMs}ms, reopen hjälpte ej`);
                markGracefulShutdown();
                process.exit(1);                                 // steg 2: ren process-restart en gång
              } else {
                console.error('[Content-Freeze] KVARSTÅR efter reopen+restart — I2S-DMA wedge under processen, ' +
                  'KRÄVER REBOOT. Churnar inte BLE med fler restarts.');
              }
            }
          } catch { /* watchdog must never crash */ }
        });
        console.log(`[Boot] Content-Freeze-Watchdog active (${CONTENT_FREEZE_MS}ms byte-identisk buffert)`);
      }
    } catch (e: any) {
      console.warn('[Boot] Playback-Watchdog failed to start:', e?.message ?? e);
    }
  })();

  // Spotify-features auto-profil BORTTAGEN (2026-08-25): inga profiler —
  // Dirigenten har EN global inställnings-uppsättning.

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

  // Hook in BLE-connect-callback: uppdatera session-marker när lampan ansluts
  // så restart-loggens uptimeBeforeMs blir korrekt. Additiv registrering —
  // engine:s egna callbacks sattes redan i ensureEngineInstance().
  try {
    const { setEngineBleCallbacks } = await import('./ble-driver/connect.js');
    setEngineBleCallbacks(() => { markSessionAlive(); }, () => {});
  } catch (e: any) {
    console.warn('[Boot] kunde inte koppla post-connect hook:', e?.message ?? e);
  }

  // ── Sonos-driven lifecycle (bil-tändning-modell) ─────────────────────────
  // Sonos playbackState är källan till sanning för om motorn ska köra.
  // (Den gamla /tmp/lotus-auto-reconnect-on-boot-flaggan är borttagen — den
  //  skrevs överallt men drev inget boot-beslut.)
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
      const {
        connectHardcoded, getHardcodedConnected,
        requestAutoReconnect, cancelAutoReconnect,
      } = await import('./ble-driver/connect.js');
      const { waitForConnectCooldown, setChurnHook } = await import('./ble-driver/connect-throttle.js');
      setChurnHook(({ attempts, pauseMs }) => {
        recordRestart('ble-churn-guard', `${attempts} connect-försök på 30s — pausar ${pauseMs}ms`);
      });
      await ignite({
        startBleEngineMinimal,
        startSonosSubsystem,
        startMicSubsystem,
        connectHardcoded: () => connectHardcoded(),
        getHardcodedConnected,
        requestAutoReconnect,
        cancelAutoReconnect,
        waitForConnectCooldown: () => waitForConnectCooldown(),
        getEngineInstance: () => engineInstance as any,

        onSonosPlayingChange: async (fn) => {
          _sonosPlayingHandler = fn;
          // Replay:a senast kända state — annars missas ett PLAYING som
          // anlände mellan startSonosSubsystem() och ignite().
          if (_lastSonosPlaying != null) await fn(_lastSonosPlaying);
        },
      });
    } catch (e: any) {
      console.warn('[Boot] ignite() fel:', e?.message ?? e);
    }
  })();

  // Crash-handlers: logga reason, exit. systemd Restart=always tar oss tillbaka.
  // Boot-handlarna lämnar plats åt dessa (annars dubbel-exit utan restart-logg).
  process.off('uncaughtException', _bootUncaught);
  process.off('unhandledRejection', _bootRejection);
  process.on('uncaughtException', (err) => {
    console.error('[Fatal/uncaughtException]', err);
    try {
      recordRestart('uncaught-exception', err?.stack ?? err?.message ?? String(err));
      markGracefulShutdown(); // säg åt nästa boot att INTE logga 'unknown' — vi har loggat reason
    } catch {}
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal/unhandledRejection]', reason);
    try {
      const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      recordRestart('unhandled-rejection', detail);
      markGracefulShutdown();
    } catch {}
    process.exit(1);
  });

  // Graceful shutdown — UI eller user-initiated. Markera session-marker
  // så nästa boot inte loggar en falsk 'unknown-systemd-restart'.
  const shutdown = async () => {
    console.log('\n[Shutdown] Cleaning up…');
    markGracefulShutdown();
    try { engineInstance?.stop(); } catch {}
    try { alsaMic?.stopMic(); } catch {}
    try { sonos?.stopSonosPoller(); } catch {}
    try {
      const { disconnectHardcoded } = await import('./ble-driver/connect.js');
      // Bounded (1500ms): ren disconnect om lampan hinner svara, annars ge upp
      // snabbt så processen alltid hinner ut innan systemd SIGKILL:ar.
      const timedOut = await Promise.race([
        disconnectHardcoded().then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 1500)),
      ]);
      if (timedOut) console.warn('[Shutdown] BLE disconnect timeout (1500ms) — avslutar ändå');
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
