/**
 * Engine lifecycle state-machine — bil-tändning-modell.
 *
 *   IGNITION   — sonos-poller + BLE-engine-minimal redo. Mic/connect sover.
 *   MOTOR_ON   — Sonos säger PLAYING. Mic + BLE connect + engine.setPlaying(true).
 *   MOTOR_OFF  — Sonos säger PAUSED. Engine setPlaying(false). Mic/BLE pausas
 *                via befintlig idle-disconnect-policy efter 2 min.
 *   IGNITION_OFF — användaren har manuellt disconnectat via UI. Vi ignorerar
 *                Sonos PLAYING tills user reaktiverar (override flag).
 *
 * Källan till sanning för auto-start är Sonos playbackState — INTE
 * /tmp/lotus-auto-reconnect-on-boot. Disk-flaggan kvarstår som redundant
 * safety net (no-op på read-sidan) men driver inte längre lifecyclen.
 */

import { getItem, setItem, removeItem } from './storage.js';
import { getSubsystemState } from './ble/state.js';

export type LifecycleState = 'IGNITION' | 'MOTOR_ON' | 'MOTOR_OFF' | 'IGNITION_OFF';

const OVERRIDE_KEY = 'lifecycle-override'; // 'off' = IGNITION_OFF, '' / saknas = auto

let state: LifecycleState = 'IGNITION';
const listeners = new Set<(s: LifecycleState) => void>();

function setState(next: LifecycleState): void {
  if (next === state) return;
  console.log(`[Lifecycle] ${state} → ${next}`);
  state = next;
  for (const fn of listeners) {
    try { fn(state); } catch {}
  }
}

export function getLifecycleState(): LifecycleState {
  return state;
}

export function subscribeLifecycle(fn: (s: LifecycleState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function isManualOverrideOff(): boolean {
  try { return getItem(OVERRIDE_KEY) === 'off'; } catch { return false; }
}

export function setManualOverrideOff(off: boolean): void {
  try {
    if (off) setItem(OVERRIDE_KEY, 'off');
    else removeItem(OVERRIDE_KEY);
  } catch {}
  setState(off ? 'IGNITION_OFF' : 'IGNITION');
}

interface IgniteDeps {
  startBleEngineMinimal: () => Promise<unknown>;
  startSonosSubsystem: () => Promise<void>;
  startMicSubsystem: () => Promise<void>;
  connectHardcoded: () => Promise<{ connected: boolean }>;
  getHardcodedConnected: () => { connected: boolean };
  isPlayingState: () => boolean;
  onSonosPlayingChange: (fn: (playing: boolean) => void) => void;
}

let _ignited = false;
let _motorOnInflight: Promise<void> | null = null;

async function toMotorOn(deps: IgniteDeps): Promise<void> {
  if (_motorOnInflight) return _motorOnInflight;
  if (state === 'IGNITION_OFF') {
    console.log('[Lifecycle] PLAYING ignorerad — manuell override aktiv (IGNITION_OFF)');
    return;
  }
  _motorOnInflight = (async () => {
    console.log('[Lifecycle] Sonos PLAYING — startar motor (mic + BLE)');
    const tasks: Promise<unknown>[] = [];
    if (getSubsystemState('mic').status !== 'ready') {
      tasks.push(
        deps.startMicSubsystem().catch(e =>
          console.warn('[Lifecycle] mic-start fel:', e?.message ?? e),
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
    setState('MOTOR_ON');
  })();
  try { await _motorOnInflight; } finally { _motorOnInflight = null; }
}

function toMotorOff(): void {
  // Engine.setPlaying(false) sköts redan av applySonosStateToEngine.
  // Idle-disconnect efter 2 min sköts av piEngine (idle-disconnect-policy).
  // Här uppdaterar vi bara state-flaggan.
  if (state === 'MOTOR_ON') setState('MOTOR_OFF');
}

/**
 * Boot-tid: startar BLE-engine-minimal + sonos-poller ovillkorligt och
 * subscribear på Sonos-events. Vid första PLAYING (eller om Sonos redan
 * spelar) körs mic+connect. Manuell UI-disconnect sätter override som
 * blockerar denna auto-path tills user reaktiverar.
 */
export async function ignite(deps: IgniteDeps): Promise<void> {
  if (_ignited) return;
  _ignited = true;

  // Respektera tidigare manuell disconnect.
  if (isManualOverrideOff()) {
    setState('IGNITION_OFF');
    console.log('[Lifecycle] Manual override aktiv vid boot — IGNITION_OFF (väntar på UI-reaktivering)');
  } else {
    setState('IGNITION');
  }

  // BLE-stack ready (laddar noble men connectar inte) + sonos-poller.
  // Båda parallellt — ingen blockerar den andra.
  const bleReady = deps.startBleEngineMinimal().catch(e =>
    console.warn('[Lifecycle/ignite] startBleEngineMinimal fel:', e?.message ?? e),
  );
  const sonosReady = deps.startSonosSubsystem().catch(e =>
    console.warn('[Lifecycle/ignite] startSonosSubsystem fel:', e?.message ?? e),
  );
  await Promise.all([bleReady, sonosReady]);

  // Subscriba på Sonos-state. onSonosChange replay:ar current state direkt
  // (fresh-status-race i sonosPoller säkerställer non-stale värde) — så om
  // Sonos redan spelar vid boot triggar vi motor på direkt.
  deps.onSonosPlayingChange((playing) => {
    if (state === 'IGNITION_OFF') return;
    if (playing) void toMotorOn(deps);
    else toMotorOff();
  });

  console.log(`[Lifecycle] ignite() klart — state=${state}, väntar på Sonos PLAYING`);
}
