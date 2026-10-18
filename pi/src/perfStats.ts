/**
 * perfStats.ts - GC, renderingstid och händelseloopens fördröjning, ALLTID PÅ (10-16, ägaren: 'mät först' innan skräpjakten).
 * Svarar på frågan: vilken sorts GC-stopp (små scavenge eller stora mark-compact) stoppar huvudtråden, hur ofta och hur länge, och
 * hur lång tid tar en rendering (DMX: effects.render + DMX-sändningen; lotus: tickInner). Samma fil i båda repona. Ingen loggning, inget i ljusvägen: läses via GET /api/perf.
 *
 * Kostnad: GC-observatören och loopmätaren är nodens egna (native, en post per GC resp. ett histogram); renderingstiden = två
 * performance.now() per ruta. Analysatorns tråd (om DMX_ANALYSER_SPLIT=worker) har egen GC som inte stoppar renderingen - syns inte här.
 *
 * Fönster: innevarande minut + de 15 senaste avslutade minuterna + totalt sedan start. Läsningen nollställer ingenting.
 */
import { PerformanceObserver, monitorEventLoopDelay, constants } from "node:perf_hooks";

type Gc = { n: number; ms: number; max: number };
type Bucket = {
  startIso: string;
  gc: { minor: Gc; major: Gc; incremental: Gc; weak: Gc };
  render: { n: number; ms: number; max: number; over1: number; over2: number; over5: number };
  loop?: { meanMs: number; p99Ms: number; maxMs: number };
  heapMb?: number;
};
const gc0 = (): Gc => ({ n: 0, ms: 0, max: 0 });
const newBucket = (): Bucket => ({
  startIso: new Date().toISOString(),
  gc: { minor: gc0(), major: gc0(), incremental: gc0(), weak: gc0() },
  render: { n: 0, ms: 0, max: 0, over1: 0, over2: 0, over5: 0 },
});

let cur = newBucket();
const hist: Bucket[] = [];
const total = newBucket();
const startedIso = total.startIso;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

function addGc(g: Gc, ms: number) { g.n++; g.ms += ms; if (ms > g.max) g.max = ms; }
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind ?? (e as unknown as { kind?: number }).kind ?? 0;
    const k = kind === constants.NODE_PERFORMANCE_GC_MINOR ? 'minor' : kind === constants.NODE_PERFORMANCE_GC_MAJOR ? 'major'
      : kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL ? 'incremental' : 'weak';
    addGc(cur.gc[k], e.duration); addGc(total.gc[k], e.duration);
  }
});
obs.observe({ entryTypes: ["gc"] });

/** EN RENDERING / TICK: renderBegin() före, renderEnd() efter (DMX: effects.render + dmx.send; lotus: tickInner). Skräpfritt på Node 18
 *  (10-18): inga argument (ett decimaltal som argument packas in), ingen array per anrop, starttiden i en Float64Array (en decimal-`let`
 *  på modulnivå packas in vid varje skrivning). Förr noteRenderMs(ms) med `for (const r of [cur.render, total.render])` = ~48 B/rendering. */
const T0 = new Float64Array(1);
export function renderBegin(): void { T0[0] = performance.now(); }
export function renderEnd(): void {
  const ms = performance.now() - T0[0];
  let r = cur.render; r.n++; r.ms += ms; if (ms > r.max) r.max = ms; if (ms > 1) r.over1++; if (ms > 2) r.over2++; if (ms > 5) r.over5++;
  r = total.render; r.n++; r.ms += ms; if (ms > r.max) r.max = ms; if (ms > 1) r.over1++; if (ms > 2) r.over2++; if (ms > 5) r.over5++;
}

/** TVINGADE STÄDNINGAR (DMX gcDark.ts / lotus gcIfNearLimit, 2026-10-18): paus, orsak och gamla minnets fyllnad - de senaste 10 + antal. */
const forced: { iso: string; why: string; ms: number; usedMb: number; limitMb: number; afterMb: number }[] = [];
let forcedN = 0, forcedMax = 0;
export function noteForcedGc(ms: number, why: string, usedMb: number, limitMb: number, afterMb: number): void {
  forcedN++; if (ms > forcedMax) forcedMax = ms;
  forced.push({ iso: new Date().toISOString(), why, ms: +ms.toFixed(1), usedMb: +usedMb.toFixed(1), limitMb: +limitMb.toFixed(1), afterMb: +afterMb.toFixed(1) });
  if (forced.length > 10) forced.shift();
}

function closeMinute(): void {
  const ns = 1e-6;
  cur.loop = { meanMs: +(loop.mean * ns).toFixed(2), p99Ms: +(loop.percentile(99) * ns).toFixed(2), maxMs: +(loop.max * ns).toFixed(2) };
  cur.heapMb = +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
  loop.reset();
  hist.push(cur); if (hist.length > 15) hist.shift();
  cur = newBucket();
}
setInterval(closeMinute, 60_000).unref();

const round = (b: Bucket) => ({
  ...b,
  gc: Object.fromEntries(Object.entries(b.gc).map(([k, g]) => [k, { n: g.n, ms: +g.ms.toFixed(1), max: +g.max.toFixed(1) }])),
  render: { ...b.render, ms: +b.render.ms.toFixed(1), max: +b.render.max.toFixed(2), meanMs: b.render.n ? +(b.render.ms / b.render.n).toFixed(3) : 0 },
});

/** GET /api/perf */
export function getPerf() {
  return { startedIso, now: new Date().toISOString(), current: round(cur), minutes: hist.map(round), total: round(total), forcedGc: { n: forcedN, maxMs: +forcedMax.toFixed(1), last: forced } };
}
