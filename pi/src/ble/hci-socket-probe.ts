/**
 * HCI raw socket probe — verifies that the process can ACTUALLY open
 * an AF_BLUETOOTH/HCI raw socket (the same syscall noble does internally).
 *
 * Why: /proc/self/status CapEff can show CAP_NET_RAW set but the socket()
 * call still fails with EPERM in some edge cases (kernel LSM, AppArmor,
 * NoNewPrivileges quirks, ambient-vs-effective mismatch). This probe gives
 * us the ground truth instead of trusting CapEff bits.
 */

import { execFileSync } from 'child_process';

export interface HciSocketProbeResult {
  ok: boolean;
  method: 'python-socket' | 'skipped';
  error?: string;
  errno?: string;
  details?: string;
}

/**
 * Try to open an HCI raw socket via python3. Just socket() — vi skippar
 * bind() helt eftersom det kräver mer komplex sockaddr-struct än Pythons
 * stdlib exponerar enkelt. socket() själv triggar EPERM-checken i kerneln
 * när CAP_NET_RAW saknas, så det räcker som ground truth-test.
 *
 * AF_BLUETOOTH=31, SOCK_RAW=3, BTPROTO_HCI=1.
 */
export function probeHciSocket(): HciSocketProbeResult {
  const py = `
import socket, sys
try:
    s = socket.socket(31, 3, 1)
    s.close()
    print("OK")
except OSError as e:
    print("ERR:" + (e.errno and __import__("errno").errorcode.get(e.errno, str(e.errno)) or "?") + ":" + str(e))
    sys.exit(1)
except Exception as e:
    print("EXC:" + type(e).__name__ + ":" + str(e))
    sys.exit(2)
`.trim();

  try {
    const out = execFileSync('python3', ['-c', py], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (out === 'OK') {
      return { ok: true, method: 'python-socket', details: 'AF_BLUETOOTH SOCK_RAW socket() OK' };
    }
    return { ok: false, method: 'python-socket', error: out };
  } catch (e: any) {
    const stderr = (e?.stderr ?? '').toString().trim();
    const stdout = (e?.stdout ?? '').toString().trim();
    const msg = stdout || stderr || e?.message || String(e);

    if (/ENOENT|not found|command not found/i.test(msg) && !stdout) {
      return { ok: false, method: 'skipped', error: 'python3 not available' };
    }

    // Parsa "ERR:EPERM:..." eller "ERR:EAFNOSUPPORT:..."
    const errnoMatch = stdout.match(/^ERR:([A-Z]+):/);
    const errno = errnoMatch ? errnoMatch[1] : undefined;

    let friendly = msg;
    if (errno === 'EPERM') friendly = 'EPERM — saknar CAP_NET_RAW (caps trasiga på kernel-nivå)';
    else if (errno === 'EAFNOSUPPORT') friendly = 'EAFNOSUPPORT — AF_BLUETOOTH inte kompilerat in i kerneln (ovanligt på Pi OS)';
    else if (errno === 'EPROTONOSUPPORT') friendly = 'EPROTONOSUPPORT — BTPROTO_HCI inte tillgängligt';

    return {
      ok: false,
      method: 'python-socket',
      errno,
      error: friendly,
      details: stdout || stderr || undefined,
    };
  }
}
