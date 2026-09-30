// --import-modul for skrapbanken: 1 ms timerupplosning (Windows), falska noble/alsa via loader-krokar, och en
// samplande allokeringsprofil (HeapProfiler.startSampling med includeObjectsCollectedBy*GC) i ett VARMT fonster.
//   PROF_WARM_S (uppvarmning), PROF_SECS (samplat fonster, 0 = ingen profil), RUN_S (total korning), PROF_OUT (prefix)
import { register, createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import fs from 'node:fs';
import v8 from 'node:v8';

const require = createRequire(import.meta.url);
try { const koffi = require('koffi'); koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32)')(1); } catch (e) { process.stderr.write('timeBeginPeriod: ' + e.message + '\n'); }
register('./hooks.mjs', import.meta.url);

if (isMainThread) {
  // bara lokala anrop (gatewayen): Deezer m.m. blockeras sa banken aldrig gar ut pa natet
  const _fetch = globalThis.fetch; globalThis.fetch = (u, o) => { const s = String(u?.url ?? u); if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s)) return Promise.reject(new Error('bank: natverk blockerat ' + s)); return _fetch(u, o); };
  const WARM = Number(process.env.PROF_WARM_S ?? 120), SECS = Number(process.env.PROF_SECS ?? 0), RUN = Number(process.env.RUN_S ?? 300);
  const OUT = process.env.PROF_OUT || 'prof';
  const mark = (s) => process.stdout.write(`=== ${s} t=${(performance.now() / 1000).toFixed(1)} ===\n`);
  const mem = () => { const m = process.memoryUsage(); const h = v8.getHeapStatistics(); return { rssMB: +(m.rss / 1048576).toFixed(1), heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), heapTotalMB: +(m.heapTotal / 1048576).toFixed(1), externalMB: +(m.external / 1048576).toFixed(1), totalAllocatedMB: +(h.total_allocated_bytes ?? 0) / 1048576 }; };
  let session = null, t0 = 0, m0 = null;
  setTimeout(async () => {
    mark('WARM END / WINDOW START'); m0 = mem(); t0 = performance.now();
    process.stdout.write(`MEM0 ${JSON.stringify(m0)}\n`);
    if (SECS > 0) {
      const inspector = await import('node:inspector');
      session = new inspector.Session(); session.connect();
      const post = (m, p) => new Promise((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
      await post('HeapProfiler.enable');
      await post('HeapProfiler.startSampling', { samplingInterval: Number(process.env.PROF_INTERVAL ?? 1024), includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      setTimeout(async () => {
        const { profile } = await post('HeapProfiler.stopSampling');
        const dt = (performance.now() - t0) / 1000;
        fs.writeFileSync(`${OUT}.heapprofile`, JSON.stringify(profile));
        process.stdout.write(`PROFILE ${OUT}.heapprofile ${dt.toFixed(1)} s\n`);
        mark('PROFILE END');
      }, SECS * 1000);
    }
  }, WARM * 1000).unref?.();
  setTimeout(() => {
    const m1 = mem(); const dt = (performance.now() - t0) / 1000;
    mark('RUN END');
    process.stdout.write(`MEM1 ${JSON.stringify(m1)} window ${dt.toFixed(1)} s\n`);
    process.exit(0);
  }, RUN * 1000);
}
