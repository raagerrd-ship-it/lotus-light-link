// BEVIS: heartbeat/heartbeat.ts ar en VERBATIM utbrytning ur piEngine steg 6 (2026-09-23). Referensfunktionerna har ar
// ordagranna kopior av den gamla inline-koden; modulen ska ge bit-identiska tal pa 200 000 slumpade indata + en simulerad
// pulsring. Kor: node pi/scripts/heartbeatProof.mjs   (efter npx tsc)
import { pulseEnvelope, pulseAmpFor, PulseTrack, pulseSplit, trustRaw, trustSmooth, ceilingFrom, composeEnergy, toNormalized } from '../dist/heartbeat/heartbeat.js';

// ── referens (gamla piEngine-koden, ordagrant) ──
function refPpEnv(dt, amp, cal, pulseIntervalMs, shapeRel) {
  if (dt < 0) return 0;
  const r = cal.onsetRiseMs ?? 0; const H = r > 0 ? r * (cal.onsetRiseHoldK ?? 2.0) : 0;
  if (dt <= H) return r > 0 ? amp * (1 - Math.exp(-dt / r)) : amp;
  const peak = r > 0 ? amp * (1 - Math.exp(-H / r)) : amp;
  let tauS = 1 / Math.log(25);
  if ((cal.fadeMode ?? 0) === 2 && pulseIntervalMs > 0) {
    const _rel = Math.min(1, Math.max(0, shapeRel ?? 1));
    const _fE = (cal.fadeEnergyCalm ?? 1.0) + ((cal.fadeEnergyIntense ?? 1.0) - (cal.fadeEnergyCalm ?? 1.0)) * _rel;
    tauS = Math.max(cal.fadeTauMin ?? 0.12, Math.min(cal.fadeTauMax ?? 1.2, (cal.fadeIntervalK ?? 0.35) * (pulseIntervalMs / 1000) * _fE));
  }
  return peak * Math.exp(-(dt - H) / (tauS * 1000));
}
function refAmpFor(idx, subdivLevel, accent, shift) {
  const fireBase = subdivLevel !== -1 || ((((idx % 2) + 2) % 2) === 0);
  if (!fireBase) return 0;
  const onOne = accent > 1 && shift >= 0 && ((((idx + shift) % 4) + 4) % 4) === 0;
  return onOne ? Math.min(1, 0.45 * accent) : 0.45;
}
function refSplit(onsetBoost, ppOut, barAccent) {
  const NOM = 0.45; const p = Math.max(onsetBoost, ppOut) / NOM; const pn = p < 1 ? p : 1;
  const acc = Math.max(1, barAccent); const one = acc > 1 ? Math.min(1, Math.max(0, p - 1) / (acc - 1)) : 0;
  return { p, pn, one };
}
function refCeil(shapeUse, bu, gain, one, lift, lv, dynDb, dynFloor) {
  let ceil = shapeUse * (1 + bu * gain); ceil += (1 - ceil) * one * lift; if (ceil > 1) ceil = 1;
  if (dynDb > 0 && lv < 0) { const g = 1 + lv / dynDb; ceil *= g > dynFloor ? g : dynFloor; }
  return ceil;
}
function refEnergy(ceil, secScale, build, bd, pn, dropBoost, floorN) {
  let energyForm = ceil * secScale * build * ((1 - bd) + bd * pn);
  if (dropBoost > 0) energyForm += dropBoost * (1 - energyForm);
  if (energyForm > 1) energyForm = 1;
  let outN = floorN + energyForm * (1 - floorN); if (outN < floorN) outN = floorN; if (outN > 1) outN = 1;
  return { energyForm, outN };
}
function refTrust(c, has, lo, hi, prev, tick, up, down) {
  const raw = has ? Math.min(1, Math.max(0, (c - lo) / Math.max(1e-6, hi - lo))) : 0;
  const a = Math.min(1, tick / (prev != null && raw < prev ? down : up));
  return { raw, sm: prev == null ? raw : prev + (raw - prev) * a };
}

let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
let n = 0, diff = 0;
const eq = (a, b, tag) => { n++; if (!Object.is(a, b)) { diff++; if (diff <= 5) console.log('AVVIKELSE', tag, a, b); } };

for (let i = 0; i < 200000; i++) {
  const cal = { onsetRiseMs: pick([0, 24, 36, 48]), onsetRiseHoldK: pick([1, 2, 2.5]), fadeMode: pick([0, 2]), fadeEnergyCalm: rnd() * 2, fadeEnergyIntense: rnd() * 2, fadeTauMin: 0.05 + rnd() * 0.2, fadeTauMax: 0.5 + rnd(), fadeIntervalK: rnd() };
  const piv = pick([0, 300, 461.5, 750]); const rel = rnd() * 1.4 - 0.2; const dt = rnd() * 1500 - 100; const amp = rnd();
  const p = { riseMs: cal.onsetRiseMs, riseHoldK: cal.onsetRiseHoldK, fadeMode: cal.fadeMode, pulseIntervalMs: piv, shapeRel: rel, fadeEnergyCalm: cal.fadeEnergyCalm, fadeEnergyIntense: cal.fadeEnergyIntense, fadeTauMin: cal.fadeTauMin, fadeTauMax: cal.fadeTauMax, fadeIntervalK: cal.fadeIntervalK };
  eq(pulseEnvelope(dt, amp, p), refPpEnv(dt, amp, cal, piv, rel), 'env');
  const idx = Math.floor(rnd() * 1000) - 500, sub = pick([-1, 0, 1]), acc = pick([1, 1.3, 1.6, 2.2]), shift = pick([-1, 0, 1, 2, 3]);
  eq(pulseAmpFor(idx, sub, acc, shift), refAmpFor(idx, sub, acc, shift), 'amp');
  const ob = rnd() * 0.9, po = rnd() * 0.9; const s1 = pulseSplit(ob, po, acc), s2 = refSplit(ob, po, acc);
  eq(s1.p, s2.p, 'p'); eq(s1.pn, s2.pn, 'pn'); eq(s1.one, s2.one, 'one');
  const shape = rnd(), bu = rnd(), gain = rnd() * 0.5, lift = rnd() * 0.5, lv = rnd() * 30 - 25, dynDb = pick([0, 12, 6]), dynFloor = 0.2 + rnd() * 0.5;
  const c1 = ceilingFrom(shape, bu, gain, s1.one, lift, lv, dynDb, dynFloor), c2 = refCeil(shape, bu, gain, s2.one, lift, lv, dynDb, dynFloor);
  eq(c1, c2, 'ceil');
  const secScale = rnd(), build = 0.5 + rnd(), bd = rnd(), drop = pick([0, rnd()]), floorN = rnd() * 0.3;
  const e1 = composeEnergy(c1, secScale, build, bd, s1.pn, drop), r2 = refEnergy(c2, secScale, build, bd, s2.pn, drop, floorN);
  eq(e1, r2.energyForm, 'energy'); eq(toNormalized(e1, floorN), r2.outN, 'outN');
  const conf = rnd() * 1.2 - 0.1, has = rnd() > 0.2, lo = 0.3, hi = 0.7, prev = pick([undefined, rnd()]), tick = pick([17.5, 24, 18]), up = 400, down = 3000;
  const t2 = refTrust(conf, has, lo, hi, prev, tick, up, down); const raw1 = trustRaw(conf, has, lo, hi);
  eq(raw1, t2.raw, 'trustRaw'); eq(trustSmooth(raw1, prev, tick, up, down), t2.sm, 'trustSm');
}
// pulsringen: referensimplementation ordagrant
class RefRing { constructor() { this.T = new Float64Array(8); this.A = new Float64Array(8); this.I = new Float64Array(8).fill(-1e9); this.P = 0; }
  push(k, t, a) { for (let i = 0; i < 8; i++) if (this.I[i] === k) { if (a > this.A[i]) this.A[i] = a; return; } this.T[this.P] = t; this.A[this.P] = a; this.I[this.P] = k; this.P = (this.P + 1) & 7; }
  clear() { this.I.fill(-1e9); }
  value(tDisp, cal, piv, rel) { let out = 0; for (let i = 0; i < 8; i++) { if (this.I[i] <= -1e9) continue; const v = refPpEnv(tDisp - this.T[i], this.A[i], cal, piv, rel); if (v > out) out = v; } return out; } }
const ring = new RefRing(), track = new PulseTrack(); const cal = { onsetRiseMs: 36, onsetRiseHoldK: 2, fadeMode: 2, fadeIntervalK: 0.45, fadeTauMin: 0.12, fadeTauMax: 1.2, fadeEnergyCalm: 1, fadeEnergyIntense: 1 };
const pp = { riseMs: 36, riseHoldK: 2, fadeMode: 2, pulseIntervalMs: 461.5, shapeRel: 0.6, fadeEnergyCalm: 1, fadeEnergyIntense: 1, fadeTauMin: 0.12, fadeTauMax: 1.2, fadeIntervalK: 0.45 };
let t = 0;
for (let i = 0; i < 50000; i++) {
  const r = rnd();
  if (r < 0.3) { const k = Math.floor(t / 461.5) + pick([0, 0.5]); const a = pick([0.45, 0.6, 0.9]); ring.push(k, t - 72, a); track.push(k, t - 72, a); }
  else if (r < 0.32) { ring.clear(); track.clear(); }
  t += 17.5 * rnd() * 2;
  eq(track.valueAt(t + 40, pp), ring.value(t + 40, cal, 461.5, 0.6), 'ring');
}
console.log(`heartbeatProof: ${n} jamforelser, ${diff} avvikelser ${diff === 0 ? '- IDENTISKT' : '- FEL'}`);
process.exit(diff === 0 ? 0 : 1);
