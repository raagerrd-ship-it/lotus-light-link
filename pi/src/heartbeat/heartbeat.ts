/**
 * HEART-BEAT / ENERGI (2026-09-23): pulsen och energitaket som EGEN del, utbruten ur piEngine steg 6 utan beteendeändring.
 * Alla formler är flyttade VERBATIM (pi/scripts/heartbeatProof.mjs bevisar bit-identiskt mot referenskopior av den gamla
 * koden). Lagret vet inget om lampor och inget om BLE/DMX — det räknar två globala tal (Envelope i contract.ts) ur analysens
 * signaler och kalibreringens rattar. Samma modul ska in i pi-dmx i stället för LIVE_LEVEL/BEAT_LIFT/postprocess.
 *
 * Tidsbaser: pulsen räknas för paketets VISNINGSögonblick (tDisp = nu + tid till radions nästa händelse + lampans latens),
 * så att toppen landar på slaget + kedjans mätta latens (30 ms, beatLeadMs = bara fade-in). Se piEngine.ppTick.
 */

export interface PulseShapeParams {
  /** onsetRiseMs: EMA-stigning; 0 = instant. */
  riseMs: number;
  /** onsetRiseHoldK: hold = riseHoldK × riseMs innan avklingning (standard 2,0). */
  riseHoldK: number;
  /** fadeMode 2 = tau ur pulsintervallet (fadeIntervalK × intervall × energifaktor), annars 0,04 per s. */
  fadeMode: number;
  pulseIntervalMs: number;
  /** _shapeRel 0..1 (nivå relativt låtens topp) → energifaktor mellan fadeEnergyCalm och fadeEnergyIntense. */
  shapeRel: number;
  fadeEnergyCalm: number; fadeEnergyIntense: number; fadeTauMin: number; fadeTauMax: number; fadeIntervalK: number;
}

/** Pulsens envelope vid dt ms efter pulsstart. (= gamla ppEnv) */
export function pulseEnvelope(dt: number, amp: number, p: PulseShapeParams): number {
  if (dt < 0) return 0;
  const r = p.riseMs; const H = r > 0 ? r * p.riseHoldK : 0;
  if (dt <= H) return r > 0 ? amp * (1 - Math.exp(-dt / r)) : amp;
  const peak = r > 0 ? amp * (1 - Math.exp(-H / r)) : amp;
  let tauS = 1 / Math.log(25);   // 0,04 per sekund
  if (p.fadeMode === 2 && p.pulseIntervalMs > 0) {
    const _rel = Math.min(1, Math.max(0, p.shapeRel));
    const _fE = p.fadeEnergyCalm + (p.fadeEnergyIntense - p.fadeEnergyCalm) * _rel;
    tauS = Math.max(p.fadeTauMin, Math.min(p.fadeTauMax, p.fadeIntervalK * (p.pulseIntervalMs / 1000) * _fE));
  }
  return peak * Math.exp(-(dt - H) / (tauS * 1000));
}

/** Amplitud för slag idx: 0,45 på vanligt slag, 0,45×accent på ettan (barShift ≥ 0), 0 = slaget presenteras inte
 *  (subdivLevel −1 = halva takten: bara jämna slag). (= gamla ppAmpFor) */
export function pulseAmpFor(idx: number, subdivLevel: number, accent: number, barShift: number): number {
  const fireBase = subdivLevel !== -1 || ((((idx % 2) + 2) % 2) === 0);
  if (!fireBase) return 0;
  const onOne = accent > 1 && barShift >= 0 && ((((idx + barShift) % 4) + 4) % 4) === 0;
  return onOne ? Math.min(1, 0.45 * accent) : 0.45;
}

/** De senaste slagen som händelser (pulsstart i väggtid, amplitud), nyckel = slagindex (dedupe ram/tick). (= gamla _pp*-ringen) */
export class PulseTrack {
  private t = new Float64Array(8); private a = new Float64Array(8); private idx = new Float64Array(8).fill(-1e9); private pos = 0;
  push(idxKey: number, tMs: number, amp: number): void {
    for (let i = 0; i < 8; i++) if (this.idx[i] === idxKey) { if (amp > this.a[i]) this.a[i] = amp; return; }
    this.t[this.pos] = tMs; this.a[this.pos] = amp; this.idx[this.pos] = idxKey; this.pos = (this.pos + 1) & 7;
  }
  clear(): void { this.idx.fill(-1e9); }
  /** Största pulsvärdet vid visningsögonblicket tDisp. */
  valueAt(tDisp: number, p: PulseShapeParams): number {
    let out = 0;
    for (let i = 0; i < 8; i++) { if (this.idx[i] <= -1e9) continue; const v = pulseEnvelope(tDisp - this.t[i], this.a[i], p); if (v > out) out = v; }
    return out;
  }
}

/** Grid-pulsens nominella onsetTarget: pulsen normeras mot den i stället för att klampas (annars försvann ettans accent). */
export const PULSE_NOMINAL = 0.45;

/** Pulsen delad i djup INOM taket (pn 0..1) och ettans överskott (one 0..1). (= gamla p/pn/acc/one) */
export function pulseSplit(onsetBoost: number, predicted: number, barAccent: number): { p: number; pn: number; one: number } {
  const p = Math.max(onsetBoost, predicted) / PULSE_NOMINAL;
  const pn = p < 1 ? p : 1;
  const acc = Math.max(1, barAccent);
  const one = acc > 1 ? Math.min(1, Math.max(0, p - 1) / (acc - 1)) : 0;
  return { p, pn, one };
}

/** Rå tillit ur taktens konfidens (mjuk ramp lo..hi), 0 utan takt. */
export function trustRaw(confidence: number, hasBeat: boolean, lo: number, hi: number): number {
  return hasBeat ? Math.min(1, Math.max(0, (confidence - lo) / Math.max(1e-6, hi - lo))) : 0;
}
/** Asymmetrisk glättning: snabbt upp (upMs), långsamt ner (downMs). prev = undefined första gången. */
export function trustSmooth(raw: number, prev: number | undefined, tickMs: number, upMs: number, downMs: number): number {
  const a = Math.min(1, tickMs / (prev != null && raw < prev ? downMs : upMs));
  return prev == null ? raw : prev + (raw - prev) * a;
}

/** Energitaket: nivåformen × (1 + uppbyggnad·gain), ettan lyfter mot 1, klamp 1, sedan sektionsdynamik mot refrängen
 *  (levelVsHighDb < 0 → × max(floor, 1 + dB/dynDb); dynDb 0 = av). (= gamla ceil-raderna) */
export function ceilingFrom(shape: number, buildUp: number, buildUpGain: number, one: number, barAccentLift: number,
  levelVsHighDb: number, dynDb: number, dynFloor: number): number {
  let ceil = shape * (1 + buildUp * buildUpGain);
  ceil += (1 - ceil) * one * barAccentLift;
  if (ceil > 1) ceil = 1;
  if (dynDb > 0 && levelVsHighDb < 0) { const g = 1 + levelVsHighDb / dynDb; ceil *= g > dynFloor ? g : dynFloor; }
  return ceil;
}

/** Komposition till energiform 0..1: tak × sektionsskala × förväntan × ((1−bd) + bd·pn), drop lyfter mot 1. (= gamla energyForm) */
export function composeEnergy(ceil: number, secScale: number, build: number, beatDepthEff: number, pn: number, dropBoost: number): number {
  const bd = beatDepthEff;
  let energyForm = ceil * secScale * build * ((1 - bd) + bd * pn);
  if (dropBoost > 0) energyForm += dropBoost * (1 - energyForm);
  if (energyForm > 1) energyForm = 1;
  return energyForm;
}

/** Golv..1-mappning (output-lagrets första steg; ligger här tills OUTPUT bryts ut). */
export function toNormalized(energyForm: number, floorN: number): number {
  let outN = floorN + energyForm * (1 - floorN);
  if (outN < floorN) outN = floorN;
  if (outN > 1) outN = 1;
  return outN;
}
