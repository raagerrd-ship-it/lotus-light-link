/**
 * Hybrid BLE transport — bluetoothctl + gatttool fallback for when noble's
 * HCI binding stays stuck in `unknown`. Uses a long-lived gatttool interactive
 * session per device with `connect` + `char-write-cmd` against the BLEDOM
 * 0xfff3 characteristic.
 *
 * Activation is a manual user toggle (persisted in storage, controlled from UI).
 * When active:
 *   - protocol.ts routes writes through writeViaHciTransport()
 *   - reconnect/connect logic uses connectViaHciTransport() instead of noble
 */

import { spawn, type ChildProcessWithoutNullStreams, execSync } from 'child_process';
import { getItem, setItem } from '../storage.js';
import { logConnectionEvent } from './state.js';

// ── Persisted toggle ──
const STORAGE_KEY = 'ble-hci-transport-enabled';
let _enabled = getItem(STORAGE_KEY) === 'true';

export function isHciTransportEnabled(): boolean { return _enabled; }
export function setHciTransportEnabled(v: boolean): void {
  _enabled = !!v;
  setItem(STORAGE_KEY, _enabled ? 'true' : 'false');
  logConnectionEvent({ type: 'hci_reset', detail: `HCI transport ${_enabled ? 'ENABLED' : 'disabled'}` });
  if (!_enabled) disconnectHciTransport();
}

// ── Char handle for BLEDOM fff3 (commonly 0x0009 on these chips) ──
// We discover it on connect via "characteristics" command rather than hardcoding.
let charHandle: string | null = null;

// ── Active gatttool session ──
interface Session {
  proc: ChildProcessWithoutNullStreams;
  mac: string;
  connected: boolean;
  buffer: string;
}
let session: Session | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/** Wait until `marker` regex appears in stdout (or timeout) */
function waitFor(proc: ChildProcessWithoutNullStreams, marker: RegExp, timeoutMs: number, sess: Session): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = sess.buffer;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      sess.buffer = buf;
      if (marker.test(buf)) {
        proc.stdout.off('data', onData);
        clearTimeout(t);
        sess.buffer = ''; // consume
        resolve(buf);
      }
    };
    const t = setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`waitFor(${marker}) timeout after ${timeoutMs}ms (got: ${buf.slice(-200)})`));
    }, timeoutMs);
    proc.stdout.on('data', onData);
    // initial check in case data already buffered
    if (marker.test(buf)) {
      proc.stdout.off('data', onData);
      clearTimeout(t);
      sess.buffer = '';
      resolve(buf);
    }
  });
}

function send(proc: ChildProcessWithoutNullStreams, line: string): void {
  proc.stdin.write(line.endsWith('\n') ? line : line + '\n');
}

/** Discover BLEDOM fff3 characteristic handle from `characteristics` output */
function parseFff3Handle(out: string): string | null {
  // Lines look like:
  //   handle: 0x0008, char properties: 0x0c, char value handle: 0x0009, uuid: 0000fff3-0000-1000-8000-00805f9b34fb
  const m = out.match(/char value handle:\s*(0x[0-9a-f]+),\s*uuid:\s*0000fff3-/i);
  return m ? m[1] : null;
}

/** Connect via gatttool interactive session */
export async function connectViaHciTransport(mac: string, name: string): Promise<boolean> {
  // Tear down any previous session
  await disconnectHciTransport();

  // Pre-clean adapter so previous noble sockets don't block
  try {
    execSync('hciconfig hci0 reset 2>&1', { encoding: 'utf8', timeout: 3000 });
  } catch {}
  await new Promise(r => setTimeout(r, 300));

  logConnectionEvent({ type: 'connect_start', device: name, detail: `[hci] gatttool -b ${mac} -I -t public` });

  const proc = spawn('gatttool', ['-b', mac, '-I', '-t', 'public'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const sess: Session = { proc, mac, connected: false, buffer: '' };
  session = sess;

  proc.stderr.on('data', (c) => {
    const s = c.toString('utf8').trim();
    if (s) logConnectionEvent({ type: 'connect_fail', device: name, detail: `[hci stderr] ${s.slice(0, 120)}` });
  });
  proc.on('exit', (code) => {
    logConnectionEvent({ type: 'disconnect', device: name, detail: `[hci] gatttool exited code=${code}` });
    if (session === sess) session = null;
  });

  try {
    // Wait for prompt
    await waitFor(proc, /\[LE\]>/, 4000, sess);

    // Connect
    send(proc, 'connect');
    await waitFor(proc, /Connection successful|connect error/i, 8000, sess);
    if (sess.buffer.includes('connect error')) throw new Error('connect error');
    sess.connected = true;
    logConnectionEvent({ type: 'connect_ok', device: name, detail: '[hci] gatttool connected' });

    // Discover fff3 handle (cache for the session)
    if (!charHandle) {
      send(proc, 'characteristics');
      const out = await waitFor(proc, /\[LE\]>/, 5000, sess);
      charHandle = parseFff3Handle(out);
      if (!charHandle) {
        logConnectionEvent({ type: 'gatt_discovery', device: name, detail: '[hci] fff3 handle not found, defaulting to 0x0009' });
        charHandle = '0x0009';
      } else {
        logConnectionEvent({ type: 'gatt_discovery', device: name, detail: `[hci] fff3 handle = ${charHandle}` });
      }
    }

    // Send brightness-max so BLEDOM unmutes — same as noble path
    await writeViaHciTransport(Buffer.from([0x7e, 0x04, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0xef]));
    return true;
  } catch (e: any) {
    logConnectionEvent({ type: 'connect_fail', device: name, detail: `[hci] ${e.message}` });
    await disconnectHciTransport();
    return false;
  }
}

/** Send a 9-byte BLEDOM packet via gatttool char-write-cmd (no response) */
export function writeViaHciTransport(buf: Buffer): Promise<void> {
  // Serialize writes — gatttool interactive handles one command at a time.
  const next = writeQueue.then(async () => {
    const sess = session;
    if (!sess || !sess.connected || !charHandle) {
      throw new Error('hci transport not connected');
    }
    const hex = buf.toString('hex');
    send(sess.proc, `char-write-cmd ${charHandle} ${hex}`);
    // char-write-cmd is fire-and-forget; just wait for the prompt to return
    await waitFor(sess.proc, /\[LE\]>/, 800, sess);
  });
  // Don't let one failure block the chain forever
  writeQueue = next.catch(() => undefined);
  return next;
}

export function isHciTransportConnected(): boolean {
  return !!(session && session.connected);
}

export async function disconnectHciTransport(): Promise<void> {
  const sess = session;
  if (!sess) return;
  session = null;
  charHandle = null;
  try {
    if (sess.connected) sess.proc.stdin.write('disconnect\nexit\n');
    else sess.proc.stdin.write('exit\n');
  } catch {}
  // Give it 300ms to exit gracefully, then kill
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { sess.proc.kill('SIGTERM'); } catch {}
      resolve();
    }, 300);
    sess.proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}