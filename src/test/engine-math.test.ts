/**
 * Unit tests proving tick-rate independence of all engine math.
 * 
 * Strategy: simulate N seconds of input at different tick rates
 * and assert the final values converge to the same result.
 */
import { describe, it, expect } from 'vitest';
import { smooth, extraSmooth, computeBrightnessPct, applyDynamics, perceptualBrightness } from '@/lib/engine/brightnessEngine';
import { createAgcState, updateRunningMax, AGC_FLOOR } from '@/lib/engine/agc';

// Helper: run smooth() for `durationMs` total time at given tickMs
function runSmooth(initial: number, target: number, attackAlpha: number, releaseAlpha: number, tickMs: number, durationMs: number): number {
  let val = initial;
  const ticks = Math.round(durationMs / tickMs);
  for (let i = 0; i < ticks; i++) {
    val = smooth(val, target, attackAlpha, releaseAlpha, tickMs);
  }
  return val;
}

function runExtraSmooth(initial: number, target: number, smoothing: number, tickMs: number, durationMs: number): number {
  let val = initial;
  const ticks = Math.round(durationMs / tickMs);
  for (let i = 0; i < ticks; i++) {
    val = extraSmooth(val, target, smoothing, tickMs);
  }
  return val;
}

describe('smooth() tick-rate independence', () => {
  const cases = [
    { name: 'attack (rising)', initial: 0, target: 1, attack: 0.3, release: 0.1 },
    { name: 'release (falling)', initial: 1, target: 0, attack: 0.3, release: 0.1 },
    { name: 'moderate attack', initial: 0.2, target: 0.8, attack: 0.15, release: 0.05 },
  ];

  for (const c of cases) {
    it(`converges identically: ${c.name}`, () => {
      const tickRates = [30, 50, 100, 125, 200];
      const duration = 2000; // 2 seconds

      const results = tickRates.map(tickMs =>
        runSmooth(c.initial, c.target, c.attack, c.release, tickMs, duration)
      );

      // All should be within 1% of each other
      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      for (let i = 0; i < results.length; i++) {
        expect(Math.abs(results[i] - avg)).toBeLessThan(0.01);
      }
    });
  }
});

describe('extraSmooth() tick-rate independence', () => {
  const cases = [
    { name: 'medium smoothing', smoothing: 50, initial: 0, target: 100 },
    { name: 'heavy smoothing', smoothing: 90, initial: 100, target: 20 },
    { name: 'light smoothing', smoothing: 10, initial: 50, target: 80 },
  ];

  for (const c of cases) {
    it(`converges identically: ${c.name}`, () => {
      const tickRates = [30, 50, 100, 125, 200];
      const duration = 3000;

      const results = tickRates.map(tickMs =>
        runExtraSmooth(c.initial, c.target, c.smoothing, tickMs, duration)
      );

      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      for (let i = 0; i < results.length; i++) {
        expect(Math.abs(results[i] - avg)).toBeLessThan(0.5);
      }
    });
  }

  it('smoothing=0 is passthrough', () => {
    expect(extraSmooth(50, 80, 0, 125)).toBe(80);
    expect(extraSmooth(50, 80, 0, 30)).toBe(80);
  });
});

describe('AGC decay tick-rate independence', () => {
  it('decays to same level over 5 seconds regardless of tick rate', () => {
    const tickRates = [30, 50, 100, 125, 200];
    const duration = 5000;

    const results = tickRates.map(tickMs => {
      const state = createAgcState(1.0);
      // Feed silence for duration
      const ticks = Math.round(duration / tickMs);
      for (let i = 0; i < ticks; i++) {
        updateRunningMax(state, 0, 0, 0, tickMs);
      }
      return state.max;
    });

    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    for (let i = 0; i < results.length; i++) {
      // Allow 2% tolerance for rounding in tick-count conversion
      expect(Math.abs(results[i] - avg) / avg).toBeLessThan(0.02);
    }
  });

  it('grows immediately on new peaks', () => {
    const state = createAgcState(0.1);
    updateRunningMax(state, 0.5, 0.3, 0.4, 125);
    expect(state.max).toBe(0.5);
    expect(state.bassMax).toBe(0.3);
    expect(state.midHiMax).toBe(0.4);
  });

  it('never decays below AGC_FLOOR', () => {
    const state = createAgcState(AGC_FLOOR);
    for (let i = 0; i < 1000; i++) {
      updateRunningMax(state, 0, 0, 0, 125);
    }
    expect(state.max).toBeGreaterThanOrEqual(AGC_FLOOR);
  });
});

describe('computeBrightnessPct tick-rate independence', () => {
  it('dynamic center converges identically', () => {
    const tickRates = [30, 50, 100, 125, 200];
    const duration = 3000;
    const cal = { bassWeight: 0.5, dynamicDamping: 0, brightnessFloor: 0, perceptualCurve: false };

    const results = tickRates.map(tickMs => {
      let center = 0.5;
      const ticks = Math.round(duration / tickMs);
      for (let i = 0; i < ticks; i++) {
        const { newCenter } = computeBrightnessPct(0.8, 0.6, 100, center, cal, 0, tickMs);
        center = newCenter;
      }
      return center;
    });

    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    for (let i = 0; i < results.length; i++) {
      expect(Math.abs(results[i] - avg)).toBeLessThan(0.005);
    }
  });
});

describe('applyDynamics', () => {
  it('expansion pushes values away from center', () => {
    const expanded = applyDynamics(0.8, 0.5, 1);
    expect(expanded).toBeGreaterThan(0.8);
  });

  it('compression pulls values toward center', () => {
    const compressed = applyDynamics(0.8, 0.5, -1);
    expect(compressed).toBeLessThan(0.8);
    expect(compressed).toBeGreaterThan(0.5);
  });

  it('zero damping is passthrough', () => {
    expect(applyDynamics(0.7, 0.5, 0)).toBe(0.7);
  });

  it('never returns negative', () => {
    expect(applyDynamics(0, 0.5, 2)).toBeGreaterThanOrEqual(0);
    expect(applyDynamics(0.01, 0.5, -3)).toBeGreaterThanOrEqual(0);
  });
});

describe('perceptualBrightness', () => {
  it('returns floor when input <= floor', () => {
    expect(perceptualBrightness(10, 20)).toBe(20);
    expect(perceptualBrightness(0, 0)).toBe(0);
  });

  it('returns 100 at max', () => {
    expect(perceptualBrightness(100, 0)).toBe(100);
    expect(perceptualBrightness(100, 20)).toBe(100);
  });

  it('output is monotonically increasing', () => {
    let prev = 0;
    for (let pct = 0; pct <= 100; pct += 5) {
      const out = perceptualBrightness(pct);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
  });
});
