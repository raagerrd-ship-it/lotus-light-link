/**
 * Engine lifecycle — strikt bil-tändning-modell.
 *
 *   IGNITION     — endast Sonos-poller + configServer. BLE/mic sover.
 *   MOTOR_ON     — Sonos = PLAYING. Sekventiellt:
 *                    1. await startBleEngineMinimal()  (race-fix mot getNoble)
 *                    2. parallellt: startMicSubsystem() + connectHardcoded()
 *                    3. setState(MOTOR_ON); engine.setPlaying(true)
 *   IGNITION_OFF — manuell UI-disconnect. PLAYING ignoreras tills user reaktiverar.
 *
 * PAUSE-grace: PLAYING→PAUSED triggar shutdownToIgnition() efter
 * IGNITION_REENTRY_GRACE_MS (5 min). Cancelleras om PLAYING kommer tillbaka.
 * Silence-gaten håller lampan dim under pause utan BLE-disconnect, så vi
 * behöver inte den aggressiva nedrivningen — undviker 3-5s respawn-delay.
 *
 * Lifecycle är ENDA kallaren av engine.setPlaying() i nya flödet.
 * applySonosStateToEngine i index.ts har bara palette/volym/TV-mode kvar.
 */

import { getItem, setItem, removeItem } from './storage.js';
import { getSubsystemState } from './ble/subsystem-state.js';

export type LifecycleState = 'IGNITION' | 'MOTOR_ON' | 'IGNITION_OFF';

const OVERRIDE_KEY = 'lifecycle-override';
const IGNITION_REENTRY_GRACE_MS = 3_000;

let state: LifecycleState = 'IGNITION';
let pendingShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let pendingShutdownAt = 0;
const listeners = new Set<(s: LifecycleState) => void>();

// Connect-retry inom MOTOR_ON: körs om initial connectHardcoded failar.
// Cancelleras av PAUSED, IGNITION_OFF, ny toMotorOn-cykel, eller lyckad connect.
const CONNECT_RETRY_SCHEDULE_MS = [2000, 5000, 10000, 20000];
let _connectRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _connectRetryActive = false;
let _connectRetryAttempt = 0;
let _connectRetryNextAt = 0;
let _connectRetryCycle = 0;

function setState(next: LifecycleState): void {
  if (next === state) return;
  console.log(`[Lifecycle] ${state} → ${next}`);
  state = next;
  for (const fn of listeners) {
    try { fn(state); } catch {}
  }
}

export function getLifecycleState(): LifecycleState { return state; }

export function getPendingShutdownInMs(): number | null {
  if (!pendingShutdownTimer) return null;
  return Math.max(0, pendingShutdownAt - Date.now());
}

export function subscribeLifecycle(fn: (s: LifecycleState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function isManualOverrideOff(): boolean {
  try { return getItem(OVERRIDE_KEY) === 'off'; } catch { return false; }
}

function persistOverride(off: boolean): void {
  try {
    if (off) setItem(OVERRIDE_KEY, 'off');
    else removeItem(OVERRIDE_KEY);
  } catch {}
}

interface IgniteDeps {
  startBleEngineMinimal: () => Promise<{ ready: boolean }>;
  startSonosSubsystem: () => Promise<void>;
  startMicSubsystem: () => Promise<void>;
  connectHardcoded: () => Promise<{ connected: boolean }>;
  getHardcodedConnected: () => { connected: boolean };
  getEngineInstance: () => { setPlaying: (p: boolean) => void; shutdownToIgnition: () => Promise<void> } | null;
  onSonosPlayingChange: (fn: (playing: boolean) => Promise<void> | void) => Promise<void> | void;
}

let _deps: IgniteDeps | null = null;
let _ignited = false;
let _motorOnInflight: Promise<void> | null = null;

function cancelScheduledShutdown(): void {
  if (pendingShutdownTimer) {
    clearTimeout(pendingShutdownTimer);
    pendingShutdownTimer = null;
    pendingShutdownAt = 0;
    console.log('[Lifecycle] Pending shutdown cancelled (PLAYING resumed inom grace)');
  }
}

function cancelConnectRetries(reason: string): void {
  if (_connectRetryTimer) {
    clearTimeout(_connectRetryTimer);
    _connectRetryTimer = null;
  }
  if (_connectRetryActive) {
    console.log(`[Lifecycle] connect-retry avbruten (${reason})`);
  }
  _connectRetryActive = false;
  _connectRetryAttempt = 0;
  _connectRetryNextAt = 0;
}

export function getConnectRetryStatus(): { active: boolean; attempt: number; nextInMs: number | null } {
  return {
    active: _connectRetryActive,
    attempt: _connectRetryAttempt,
    nextInMs: _connectRetryNextAt ? Math.max(0, _connectRetryNextAt - Date.now()) : null,
  };
}

function scheduleConnectRetries(deps: IgniteDeps): void {
  if (_connectRetryActive) return;
  _connectRetryActive = true;
  _connectRetryCycle++;
  const cycle = _connectRetryCycle;

  const runStep = (idx: number) => {
    if (idx >= CONNECT_RETRY_SCHEDULE_MS.length) {
      console.warn(`[Lifecycle] connect-retry uttömd (${CONNECT_RETRY_SCHEDULE_MS.length} försök) — ger upp tills ny PLAYING`);
      _connectRetryActive = false;
      _connectRetryAttempt = 0;
      _connectRetryNextAt = 0;
      return;
    }
    const delay = CONNECT_RETRY_SCHEDULE_MS[idx];
    _connectRetryAttempt = idx + 1;
    _connectRetryNextAt = Date.now() + delay;
    console.log(`[Lifecycle] connect-retry ${idx + 1}/${CONNECT_RETRY_SCHEDULE_MS.length} schemalagd om ${delay}ms`);

    _connectRetryTimer = setTimeout(async () => {
      _connectRetryTimer = null;
      if (cycle !== _connectRetryCycle) return;
      if (state !== 'MOTOR_ON') { cancelConnectRetries('state ej MOTOR_ON'); return; }
      if (deps.getHardcodedConnected().connected) {
        console.log('[Lifecycle] connect-retry: redan ansluten — avbryter');
        _connectRetryActive = false; _connectRetryAttempt = 0; _connectRetryNextAt = 0;
        return;
      }
      try {
        const r = await deps.connectHardcoded();
        if (cycle !== _connectRetryCycle) return;
        if (r.connected) {
          console.log(`[Lifecycle] connect-retry ${idx + 1} lyckades`);
          _connectRetryActive = false; _connectRetryAttempt = 0; _connectRetryNextAt = 0;
          return;
        }
        console.warn(`[Lifecycle] connect-retry ${idx + 1} failed`);
      } catch (e: any) {
        console.warn(`[Lifecycle] connect-retry ${idx + 1} fel:`, e?.message ?? e);
      }
      if (cycle !== _connectRetryCycle) return;
      if (state !== 'MOTOR_ON') { cancelConnectRetries('state ej MOTOR_ON'); return; }
      runStep(idx + 1);
    }, delay);
  };
  runStep(0);
}

async function doShutdown(): Promise<void> {
  pendingShutdownTimer = null;
  pendingShutdownAt = 0;
  if (state !== 'MOTOR_ON') return;
  const eng = _deps?.getEngineInstance();
  if (eng) {
    try { eng.setPlaying(false); } catch {}
    try { await eng.shutdownToIgnition(); } catch (e: any) {
      console.warn('[Lifecycle] shutdownToIgnition fel:', e?.message ?? e);
    }
  }
  setState('IGNITION');
}

function scheduleShutdownToIgnition(): void {
  if (pendingShutdownTimer) return;
  cancelConnectRetries('PAUSED — shutdown schemalagt');
  pendingShutdownAt = Date.now() + IGNITION_REENTRY_GRACE_MS;
  console.log(`[Lifecycle] PAUSED — schemalägger shutdown om ${IGNITION_REENTRY_GRACE_MS}ms (cancellerbar)`);
  pendingShutdownTimer = setTimeout(() => { void doShutdown(); }, IGNITION_REENTRY_GRACE_MS);
}

async function toMotorOn(): Promise<void> {
  if (!_deps) return;
  if (_motorOnInflight) return _motorOnInflight;
  if (state === 'IGNITION_OFF') {
    console.log('[Lifecycle] PLAYING ignorerad — IGNITION_OFF (manuell override)');
    return;
  }
  if (state === 'MOTOR_ON') return;

  const deps = _deps;
  cancelConnectRetries('ny toMotorOn-cykel');
  _motorOnInflight = (async () => {
    console.log('[Lifecycle] PLAYING → setPlaying(true) omedelbart, subsystem startas i bakgrunden');

    // STEG 1: setPlaying(true) UNCONDITIONALLY — engine.playing måste följa
    // Sonos PLAYING direkt. BLE/mic-startup får aldrig gata detta; om de
    // misslyckas tar FFT-writes över när de blir ready.
    setState('MOTOR_ON');
    try { deps.getEngineInstance()?.setPlaying(true); } catch {}

    // STEG 2: BLE-stack + mic + connect i bakgrunden (sekventiellt BLE först).
    try {
      const r = await deps.startBleEngineMinimal();
      if (!r.ready) {
        console.warn('[Lifecycle] startBleEngineMinimal ready=false — engine.playing kvar, väntar på recovery');
        return;
      }
    } catch (e: any) {
      console.warn('[Lifecycle] startBleEngineMinimal fel:', e?.message ?? e);
      return;
    }

    const tasks: Promise<unknown>[] = [];
    if (getSubsystemState('mic').status !== 'ready') {
      tasks.push(
        deps.startMicSubsystem().catch(e =>
          console.warn('[Lifecycle] startMicSubsystem fel:', e?.message ?? e),
        ),
      );
    }
    if (!deps.getHardcodedConnected().connected) {
      tasks.push(
        deps.connectHardcoded().catch(e =>
          console.warn('[Lifecycle] connectHardcoded fel:', e?.message ?? e),
        ),
      );
    }
    await Promise.all(tasks);

    // Initial connect failed? Starta backoff-retry tills PAUSED/IGNITION_OFF/connected.
    if ((state as LifecycleState) === 'MOTOR_ON' && !deps.getHardcodedConnected().connected) {
      console.warn('[Lifecycle] initial connect failade — startar retry-sekvens (2/5/10/20s)');
      scheduleConnectRetries(deps);
    }
  })();
  try { await _motorOnInflight; } finally { _motorOnInflight = null; }
}

/** Manuellt UI: "Starta allt". Rensar override och tvingar motor-start. */
export async function userStartAll(): Promise<void> {
  persistOverride(false);
  if (state === 'IGNITION_OFF') setState('IGNITION');
  cancelScheduledShutdown();
  await toMotorOn();
}

/** Manuellt UI: "Stoppa allt"/disconnect. Sätter override + river ner direkt. */
export async function userStopAll(): Promise<void> {
  persistOverride(true);
  cancelScheduledShutdown();
  cancelConnectRetries('userStopAll');
  await doShutdown();
  setState('IGNITION_OFF');
}

/** Bakåtkompat. Behålls för configServer-endpoint. */
export function setManualOverrideOff(off: boolean): void {
  if (off) void userStopAll();
  else void userStartAll();
}

/**
 * Boot-tid: starta endast Sonos-poller + subscriba. BLE/mic startas först
 * vid första PLAYING via toMotorOn(). Override blockerar auto-start.
 */
export async function ignite(deps: IgniteDeps): Promise<void> {
  if (_ignited) return;
  _ignited = true;
  _deps = deps;

  if (isManualOverrideOff()) {
    setState('IGNITION_OFF');
    console.log('[Lifecycle] Manual override aktiv vid boot — IGNITION_OFF');
  } else {
    setState('IGNITION');
  }

  try {
    await deps.startSonosSubsystem();
  } catch (e: any) {
    console.warn('[Lifecycle/ignite] startSonosSubsystem fel:', e?.message ?? e);
  }

  await deps.onSonosPlayingChange(async (playing) => {
    if (state === 'IGNITION_OFF') return;
    if (playing) {
      cancelScheduledShutdown();
      await toMotorOn();
    } else {
      // PAUSED: schemalägg nedrivning (cancelleras om PLAYING kommer tillbaka).
      if (state === 'MOTOR_ON') scheduleShutdownToIgnition();
    }
  });

  console.log(`[Lifecycle] ignite() klart — state=${state}, väntar på Sonos PLAYING`);
}
