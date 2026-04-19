/**
 * Pipeline timing collector — zero-alloc ring buffers for per-stage
 * latency measurements. Hot-path code calls record* with performance.now()
 * deltas (already measured); we just append to a circular Float64Array.
 *
 * Stages tracked:
 *   - audioToFft:    ALSA buffer arrival → FFT frame complete
 *   - fftToTick:     FFT complete → engine tickInner start
 *   - tickInner:     engine processing (math + dynamics + onset + colorcal)
 *   - bleWrite:      noble writeAsync round-trip (resolves immediately for
 *                    write-without-response; this is enqueue cost)
 *   - endToEnd:      ALSA buffer arrival → BLE write resolved
 *                    (this is the number that matters for "lag")
 *
 * The "true" radio-air-time + BLEDOM controller delay (~5ms additional)
 * is NOT measurable from userspace — the kernel hands the packet to the
 * HCI layer and we get an immediate completion. End-to-end latency in
 * Wall-clock for the user is roughly: endToEnd + ~5ms (median).
 */

const RING_SIZE = 512;

interface RingBuffer {
  data: Float64Array;
  pos: number;
  filled: number;
}

function makeRing(): RingBuffer {
  return { data: new Float64Array(RING_SIZE), pos: 0, filled: 0 };
}

const rings = {
  audioToFft: makeRing(),
  fftToTick:  makeRing(),
  tickInner:  makeRing(),
  bleWrite:   makeRing(),
  endToEnd:   makeRing(),
};

export type StageKey = keyof typeof rings;

function record(stage: StageKey, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 1000) return; // sanity guard
  const r = rings[stage];
  r.data[r.pos] = ms;
  r.pos = (r.pos + 1) % RING_SIZE;
  if (r.filled < RING_SIZE) r.filled++;
}

export const pipelineTiming = {
  recordAudioToFft: (ms: number) => record('audioToFft', ms),
  recordFftToTick:  (ms: number) => record('fftToTick', ms),
  recordTickInner:  (ms: number) => record('tickInner', ms),
  recordBleWrite:   (ms: number) => record('bleWrite', ms),
  recordEndToEnd:   (ms: number) => record('endToEnd', ms),
};

export interface StageStats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
  avgMs: number;
}

function computeStats(r: RingBuffer): StageStats {
  const n = r.filled;
  if (n === 0) {
    return { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, minMs: 0, avgMs: 0 };
  }
  // Copy + sort (allocates on request — that's fine, it's a cold path)
  const sorted = r.data.slice(0, n).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    samples: n,
    minMs: round(sorted[0]),
    maxMs: round(sorted[n - 1]),
    avgMs: round(sum / n),
    p50Ms: round(sorted[(n * 0.5) | 0]),
    p95Ms: round(sorted[Math.min(n - 1, (n * 0.95) | 0)]),
    p99Ms: round(sorted[Math.min(n - 1, (n * 0.99) | 0)]),
  };
}

export function getPipelineTimingSnapshot() {
  return {
    audioToFft: computeStats(rings.audioToFft),
    fftToTick:  computeStats(rings.fftToTick),
    tickInner:  computeStats(rings.tickInner),
    bleWrite:   computeStats(rings.bleWrite),
    endToEnd:   computeStats(rings.endToEnd),
    ringSize: RING_SIZE,
  };
}

export function resetPipelineTiming(): void {
  for (const k of Object.keys(rings) as StageKey[]) {
    rings[k].data.fill(0);
    rings[k].pos = 0;
    rings[k].filled = 0;
  }
}
