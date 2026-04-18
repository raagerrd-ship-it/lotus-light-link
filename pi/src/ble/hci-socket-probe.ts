/**
 * HCI raw socket probe — verifies that the process can ACTUALLY open
 * an AF_BLUETOOTH/HCI raw socket (the same syscall noble does internally).
 *
 * Why: /proc/self/status CapEff can show CAP_NET_RAW set but the socket()
 * call still fails with EPERM in some edge cases (kernel LSM, AppArmor,
 * NoNewPrivileges quirks, ambient-vs-effective mismatch). This probe gives
 * us the ground truth instead of trusting CapEff bits.
 *
 * Strategy: shell out to `hcitool dev` (cheap, no permissions needed for
 * just listing) AND attempt a `hcitool lescan --duration=0` style call
 * which fails with "Set scan parameters failed: Operation not permitted"
 * if caps are missing. We don't actually run lescan — we use python3 with
 * a minimal socket() attempt, falling back to interpreting hcitool errors.
 *
 * Output: structured result that boot can log + expose via diagnostics.
 */

import { execFileSync } from 'child_process';

export interface HciSocketProbeResult {
  ok: boolean;
  method: 'python-socket' | 'hcitool-lescan' | 'skipped';
  error?: string;
  details?: string;
}

/**
 * Try to open an HCI raw socket via python3. This is the exact syscall
 * noble does internally. Returns ok:true iff socket() + bind() succeed.
 *
 * Requires python3 (always present on Pi OS). Falls back gracefully if
 * python3 is missing.
 */
export function probeHciSocket(): HciSocketProbeResult {
  // Python one-liner: open AF_BLUETOOTH SOCK_RAW BTPROTO_HCI and bind to hci0.
  // This is exactly what @stoprocent/noble does in its native binding.
  // socket.AF_BLUETOOTH=31, SOCK_RAW=3, BTPROTO_HCI=1.
  const py = `
import socket, sys, struct
try:
    s = socket.socket(31, 3, 1)
    # bind to hci0 (dev_id=0). HCI_CHANNEL_RAW=0.
    s.bind((0, 0))
    s.close()
    print("OK")
except PermissionError as e:
    print("EPERM:" + str(e))
    sys.exit(1)
except Exception as e:
    print(type(e).__name__ + ":" + str(e))
    sys.exit(2)
`.trim();

  try {
    const out = execFileSync('python3', ['-c', py], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (out === 'OK') {
      return { ok: true, method: 'python-socket', details: 'AF_BLUETOOTH SOCK_RAW bind OK' };
    }
    return { ok: false, method: 'python-socket', error: out };
  } catch (e: any) {
    const stderr = (e?.stderr ?? '').toString().trim();
    const stdout = (e?.stdout ?? '').toString().trim();
    const msg = stdout || stderr || e?.message || String(e);

    // Distinguish "python3 missing" from real EPERM
    if (/ENOENT|not found|command not found/i.test(msg) && !stdout) {
      return { ok: false, method: 'skipped', error: 'python3 not available' };
    }

    return {
      ok: false,
      method: 'python-socket',
      error: msg.includes('EPERM') ? 'EPERM — saknar CAP_NET_RAW på processen' : msg,
      details: stderr || undefined,
    };
  }
}
