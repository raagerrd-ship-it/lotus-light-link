/**
 * SH-HJALPAREN (2026-10-04): spawn()/execSync() forkar hela motorprocessen (~150 MB) och holl huvudtraden 23-31 ms
 * per anrop (cpuprofile under musik: lecup-re-asserten var 25:e s), execSync dessutom tills kommandot var klart.
 * Ett litet sh startas EN gang och forkar kommandona sjalv - samma kommando, samma exitkod, ingen fork av motorn per
 * anrop. Dor hjalparen startas en ny vid nasta anrop. Beroendefri (bara node:child_process): adapter-hci-check far
 * inte dra in noble.
 */
import { spawn, type ChildProcess } from 'node:child_process';

let helper: ChildProcess | null = null;
let helperOut = '';
let helperCur: { done: (code: number | null, out: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;
const helperQueue: Array<{ line: string; timeoutMs: number; done: (code: number | null, out: string) => void }> = [];

function helperFinish(code: number | null, out: string): void {
  const cur = helperCur; helperCur = null; helperOut = '';
  if (cur) { clearTimeout(cur.timer); cur.done(code, out); }
  helperNext();
}

function helperNext(): void {
  if (helperCur || helperQueue.length === 0) return;
  if (!helper) {
    const h = spawn('sh', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    helper = h;
    h.stdout!.on('data', (b) => {
      helperOut += b.toString();
      const m = /@@RC (\d+)\n/.exec(helperOut);
      if (m) helperFinish(Number(m[1]), helperOut.slice(0, m.index).trim());
    });
    const gone = (why: string) => { if (helper !== h) return; helper = null; helperFinish(null, `${helperOut.trim()} ${why}`.trim()); };
    h.on('exit', () => gone('hjalparen avslutad'));
    h.on('error', (e) => gone(`error: ${e?.message ?? e}`));
    h.stdin!.on('error', () => { /* hanteras av exit */ });
  }
  const job = helperQueue.shift()!;
  helperCur = { done: job.done, timer: setTimeout(() => { try { helper?.kill('SIGKILL'); } catch {} }, job.timeoutMs + 1000) };
  helper.stdin!.write(job.line);
}

/**
 * Kor `cmd` (en rad sh, stdout+stderr ihop) i hjalparen; `timeout` dodar ett hangande kommando (exit 137).
 * Anroparen ansvarar for att cmd inte innehaller ociterad indata. Svarar { code: null } om hjalparen inte kunde startas.
 */
export function shRun(cmd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    helperQueue.push({
      line: `timeout -s KILL ${Math.ceil(timeoutMs / 1000)} ${cmd} 2>&1; echo "@@RC $?"\n`,
      timeoutMs,
      done: (code, out) => resolve({ code, out }),
    });
    try { helperNext(); } catch (e: any) {
      const q = helperQueue.splice(0);
      for (const j of q) j.done(null, `spawn failed: ${e?.message ?? e}`);
    }
  });
}
