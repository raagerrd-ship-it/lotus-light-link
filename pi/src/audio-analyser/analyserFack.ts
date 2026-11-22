/** FACKEN (flytten 2026-11-21): rattarna, de delade konstanterna och typerna; varje sten får sitt fack här. Anteckningar: docs/analysator/analyserFack.md */
import { PROFILE } from './analyserProfile.js';

// RATTAR
const ENV: Record<string, string | undefined> | undefined = typeof process !== 'undefined' ? process.env : undefined;
const ALIAS_PREFIX = PROFILE.envPrefix === 'LOTUS_' ? 'DMX_' : 'LOTUS_';
export function sysEnv(name: string): string | undefined {
  return ENV?.[PROFILE.envPrefix + name] ?? ENV?.[ALIAS_PREFIX + name] ?? PROFILE.sys[name];
}
/** TEMPOKÄLLAN. */
export function env(name: string): string | undefined {
  return ENV?.[name] ?? PROFILE.bare[name];
}
export function numEnv(name: string, def: number): number { const v = sysEnv(name); const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) ? x : def; }

// KONSTANTER SOM FLER ÄN EN DEL LÄSER
export const BODY_CEIL_DB_S = 0.15;   // taket haller latens loud-referens lange
export const BE_FALLBACK_MS = 500;
export const BE_MEM_BEATS = 240;
export const BASS_SPAN_DB = 36;   // frame.bassEnergy / bassEnergyShort
export const BIG_EVERY = 3;   // kor stor-FFT var N:e hop
export const BODY_HIGH_MS = numEnv('SECTION_BODY_HIGH', 0), BODY_HIGH_DB = numEnv('SECTION_BODY_HIGH_DB', 3);   // BASEN TILLBAKA

/** Flyttal från start: skriv 0,5 och sedan värdet. */
export function stabilise(o: object, keys: readonly string[]): void {
  const r = o as Record<string, unknown>;
  for (const k of keys) { const v = r[k]; if (typeof v === 'number') { r[k] = 0.5; r[k] = v; } }
}

// TYPER
export interface BeatGrid { bpm: number; anchorMs: number; confidence?: number; }
/** Detektionsparametrar. */
export interface AnalyserDetection { autoGainTarget: number; tauUp: number; tauDown: number; noiseFloor: number; maxGain?: number }
export interface Cfg { audio: { rate: number }; fft: { size: number; hop: number }; detection: AnalyserDetection; onset: { enhancements: boolean } }
export type Role = 'all' | 'fast' | 'slow';

// TRÅDARNA (steg 18): en tagg per fält = var fältet skrivs när analysatorn är delad. Anteckningar: docs/analysator/analyserFack.md
/** S huvudtråden, L workern, IN huvudtråden före pushBig (recordet bär det till workern), UT workern (blocket bär det till huvudtråden), K konstruktorn. */
export type Tag = 'S' | 'L' | 'IN' | 'UT' | 'K';
export type Trad = 'S' | 'L';
type Synlig = { S: 'S' | 'IN' | 'UT' | 'K'; L: 'L' | 'IN' | 'UT' | 'K' };
type Fn<O> = { [K in keyof O]-?: O[K] extends (...a: never[]) => unknown ? K : never }[keyof O];
/** Varje datafält har en tagg; ett inbäddat objekt har en tagg per fält. */
type Taggat<O> = { readonly [K in Exclude<keyof O, Fn<O>>]: Tag | { readonly [k: string]: Tag } };

// FACKEN. Startvärde = dagens startvärde (byte för byte).

/** HOPPET: kärnans fält per hopp. Skrivkartan per tråd: docs/analysator/analyserFack.md. */
export class HopOut {
  static readonly TRAD = { role: 'K', bigOn: 'K', cfg: 'K', dtHop: 'K', hopMs: 'K', rms: 'IN', now: 'S', dt: 'S', nowWall: 'IN', gated: 'S',
    kickFlux: 'S', energy: 'S', flux: 'S', level: 'S', lvlSmooth: 'IN', centSmooth: 'IN', body: 'UT', breaking: 'IN', kickHit: 'IN',
    sec: 'IN', lvh: 'IN', conf: 'IN', bpm: 'IN' } as const satisfies Taggat<HopOut>;
  role: Role = 'all'; bigOn = false; cfg!: Cfg;   // skrivs en gång i Analysers konstruktor
  dtHop = 0; hopMs = 0.5;
  rms = 0.5; now = 0.5; dt = 0.5; nowWall = 0.5; gated = false;
  kickFlux = 0.5; energy = 0.5; flux = 0.5; level = 0.5; lvlSmooth = 0; centSmooth = 0.5; body = 0.5; breaking = false;
  kickHit = 0;   // trumkittet
  sec = 'intro'; lvh = 0.5; conf = 0.5; bpm = 0.5;   // långsamma värden sedda vid hoppet
  constructor(readonly wallNow: () => number) { stabilise(this, ['lvlSmooth', 'kickHit']); }   // wallNow = analysatorns väggklocka
}

/** NIVÅN. intensity = förr hIntensity, inZone = förr levels.inZoneState. */
export class LevelOut {
  static readonly TRAD = { gain: 'S', envelope: 'S', activeMs: 'IN', silentMs: 'S', intensity: 'IN', levelCeil: 'L', inZone: 'S', gainLocked: 'S' } as const satisfies Taggat<LevelOut>;   // levelCeil/inZone: zoneStep i båda trådarna
  gain = 1; envelope!: number; activeMs = 0; silentMs = -0; intensity = 0.5; levelCeil = 0.5; inZone = false; gainLocked = false;
  constructor() { stabilise(this, ['activeMs']); }
}
/** SPEKTRUMET. Banden förblir Float32Array. sink = förr specSink. */
export class SpectrumOut {
  static readonly TRAD = { bandAbs: 'L', bandDbRaw: 'L', bandLvl: 'L', bandOn: 'L', fbOn: 'S', bigN: 'L', sink: 'S' } as const satisfies Taggat<SpectrumOut>;
  readonly bandAbs = new Float32Array(8); readonly bandDbRaw = new Float32Array(8);   // absolut magnitud före AGC, rå dB
  readonly bandLvl = new Float32Array(8); readonly bandOn = new Float32Array(8); readonly fbOn = new Float32Array(8);
  bigN = 0;   // räknare: stor-FFT:er (förr flaggan secSpecDirty)
  sink: ((mag: Float32Array, binHz: number) => void) | null = null;
}
/** KICKEN. kick = förr hKick, kickAt = förr hKickAt. */
export class KickOut {
  static readonly TRAD = { kick: 'IN', kickAt: 'S', beatAnchorMs: 'S', pendingKickMs: 'S', lastKick: 'S', kfPrev: 'S', kfPrev2: 'S', dbgKick: 'S', finns: 'K' } as const satisfies Taggat<KickOut>;
  kick = false; kickAt = 0.5; finns = true;
  beatAnchorMs = 0; pendingKickMs = 0; lastKick = 0; kfPrev = 0; kfPrev2 = 0;
  dbgKick: { flux: number; thresh: number; med: number; mad: number; energy: number; gain: number; rms: number; env: number; locked: boolean } | null = null;
  constructor() { stabilise(this, ['pendingKickMs', 'kfPrev', 'kfPrev2', 'beatAnchorMs', 'lastKick']); }
  neutral(): void { this.kickAt = 0; }   // kicken av: ingen förfinad kick (0,5 vore en kick vid 0,5 ms för klockan)
}
/** KLOCKAN sedd av analysatorn: bpm/conf = förr localBpm/localBpmConfidence, phaseMs/phaseConf = gridfasen, src = förr beatSrc (samma objekt). */
export class ClockOut {
  static readonly TRAD = { bpm: 'IN', conf: 'IN', phaseMs: 'UT', phaseConf: 'UT', src: 'S' } as const satisfies Taggat<ClockOut>;
  bpm = 0; conf = 0; phaseMs = 0; phaseConf = 0;
  src!: { beat?: BeatGrid | null };
  constructor() { stabilise(this, ['conf']); }
  resetPhase(): void { this.phaseMs = 0; this.phaseConf = 0; }   // hopp i klockan (setVirtualClock)
  zeroBpm(): void { this.bpm = 0; }   // tystnad 10 s (nivån, F_SIL10)
}

/** SEKTIONEN: de 17 publicerade fälten (förr på Analyser). */
export class SectionOut {
  static readonly TRAD = { section: 'UT', sectionStartMs: 'UT', sectionIndex: 'UT', sectionTier: 'UT', prevSection: 'UT', levelVsHighDb: 'UT',
    repeatSim: 'UT', repeatAgoMs: 'UT', repeatSection: 'UT', repeatTier: 'L', repeatHighAtMs: 'L', repeatHighEndAtMs: 'L',
    expectHighMs: 'UT', expectSource: 'UT', secBuildAt: 'UT', secBuildSeen: 'UT', boundaryNov: 'L', finns: 'K' } as const satisfies Taggat<SectionOut>;
  section = 'intro'; sectionStartMs = 0; sectionIndex = 0; sectionTier = 1; prevSection = ''; levelVsHighDb = 0;
  repeatSim = 0; repeatAgoMs = 0; repeatSection = ''; repeatTier = -1; repeatHighAtMs = 0; repeatHighEndAtMs = 0;
  expectHighMs = 0; expectSource = 0; secBuildAt = 0; secBuildSeen = 0; boundaryNov = 0; finns = true;
  constructor() { stabilise(this, ['expectHighMs', 'levelVsHighDb', 'sectionStartMs', 'secBuildAt', 'secBuildSeen', 'repeatSim', 'repeatAgoMs']); }
  neutral(): void { this.section = ''; }   // sektionen av: '' = okänd (sectionCode 0); 'intro' skulle ge drops lugn-veto
}
/** BASEN. bassline/onsetsPerBeat = förr profBassline/bassOnsetsPerBeat. */
export class BassOut {
  static readonly TRAD = { beHi: 'S', beRef: 'S', beShort: 'S', energy: 'S', bassline: 'L', onsetsPerBeat: 'L', finns: 'K' } as const satisfies Taggat<BassOut>;
  beHi = NaN; beRef = NaN; beShort = 0; energy = 0; bassline = 0; onsetsPerBeat = 0; finns = true;
  constructor() { stabilise(this, ['bassline', 'onsetsPerBeat']); }
  neutral(): void { this.beHi = 0; this.beRef = 0; }   // basen av: bassLevel 1 i stället för NaN
}
/** UPPBYGGNADEN. inRiser = förr hInRiser. */
export class RiserOut {
  static readonly TRAD = { buildUp: 'UT', inRiser: 'UT', finns: 'K' } as const satisfies Taggat<RiserOut>;
  buildUp = 0; inRiser = false; finns = true; constructor() { stabilise(this, ['buildUp']); }
}
/** DROP. */
export class DropOut {
  static readonly TRAD = { dropCount: 'UT', miniDropCount: 'UT', buildStartCount: 'UT', dropCand: 'UT', secBodyRet: 'L', dropDemoted: 'UT', dropSpaced: 'UT',
    dropRiseDb: 'UT', nearDropDb: 'UT', nearDipDb: 'UT', liftDb: 'UT', stopCount: 'UT', stopS: 'UT', lastDropMs: 'L', bodyUnderDb: 'UT', finns: 'K' } as const satisfies Taggat<DropOut>;
  dropCount = 0; miniDropCount = 0; buildStartCount = 0; dropCand = 0; secBodyRet = 0;
  dropDemoted = 0; dropSpaced = 0; dropRiseDb = -0; nearDropDb = -0; nearDipDb = -0; liftDb = -0; stopCount = 0; stopS = -0;
  lastDropMs = -1.5e9; bodyUnderDb = 0; finns = true;   // lastDropMs utanför Smi-intervallet
  constructor() { stabilise(this, ['lastDropMs', 'dropRiseDb', 'nearDropDb', 'nearDipDb', 'liftDb', 'stopS']); }
}
/** KARAKTÄREN. profile = förr character.outProfile, ramens profile pekar hit. */
export class CharacterOut {
  static readonly TRAD = { profile: { punch: 'UT', bass: 'UT', bright: 'UT', beat: 'UT', bassline: 'UT' }, finns: 'K' } as const satisfies Taggat<CharacterOut>;
  readonly profile = { punch: 0.4, bass: 0.5, bright: 0.3, beat: 0.5, bassline: 0 }; finns = true;
}

/** Registret: ett fack per sten. */
export const FACK = { hop: HopOut, level: LevelOut, spectrum: SpectrumOut, kick: KickOut, clock: ClockOut,
  section: SectionOut, bass: BassOut, riser: RiserOut, drop: DropOut, character: CharacterOut } as const;
export type FackNamn = keyof typeof FACK;
export type Fack = { [N in FackNamn]: InstanceType<(typeof FACK)[N]> };
export function makeFack(wallNow: () => number): Fack {
  return { hop: new HopOut(wallNow), level: new LevelOut(), spectrum: new SpectrumOut(), kick: new KickOut(), clock: new ClockOut(),
    section: new SectionOut(), bass: new BassOut(), riser: new RiserOut(), drop: new DropOut(), character: new CharacterOut() };
}

type TagAv<N extends FackNamn> = (typeof FACK)[N]['TRAD'];
type Har<V, G> = V extends string ? (V extends G ? 1 : 0) : V extends { readonly [k: string]: infer U } ? ([U] extends [G] ? 1 : 0) : 0;
/** Fälten i fack N med en tagg ur G. */
export type MedTag<N extends FackNamn, G> = { [K in keyof TagAv<N>]: Har<TagAv<N>[K], G> extends 1 ? K : never }[keyof TagAv<N>];
/** Det en sten i tråden T får läsa i fack N: fälten med en synlig tagg, och fackets metoder. */
export type Synliga<T extends Trad, N extends FackNamn> = (MedTag<N, Synlig[T]> | Fn<Fack[N]>) & keyof Fack[N];
/** En stens läsning: `hop: Ser<'L', 'hop', 'dtHop' | 'bpm'>`. Ett fält som skrivs i den andra tråden ger tsc-fel på raden. */
export type Ser<T extends Trad, N extends FackNamn, K extends Synliga<T, N>> = Readonly<Pick<Fack[N], K>>;

type PlatsAv<V> = V extends string ? number : { readonly [k in keyof V]: number };
/** Platserna i ett block mellan trådarna: fälten med taggen G i facken F, efter kärnans `forst` platser. */
export type Platser<G extends Tag, F extends FackNamn> = { readonly [N in F]: { readonly [K in MedTag<N, G>]: PlatsAv<TagAv<N>[K]> } } & { readonly LEN: number };
/** Räknas en gång vid laddning (split.ts): ordningen = facklistans och TRAD-radens. */
export function platser<G extends Tag, F extends FackNamn>(tag: G, fack: readonly F[], forst: number): Platser<G, F> {
  let i = forst; const ut: Record<string, unknown> = {};
  for (const n of fack) {
    const t: Record<string, Tag | Record<string, Tag>> = FACK[n].TRAD, m: Record<string, unknown> = {};
    for (const k in t) {
      const v = t[k];
      if (v === tag) m[k] = i++;
      else if (typeof v === 'object' && Object.values(v).every((x) => x === tag)) { const d: Record<string, number> = {}; for (const j in v) d[j] = i++; m[k] = Object.freeze(d); }
    }
    ut[n] = Object.freeze(m);
  }
  ut.LEN = i; return Object.freeze(ut) as Platser<G, F>;
}
/** Antal fält med taggen i alla fack (split.ts: varje IN- och UT-fält ska ha en plats). */
export function antal(tag: Tag): number {
  let c = 0;
  for (const n in FACK) { const t: Record<string, Tag | Record<string, Tag>> = FACK[n as FackNamn].TRAD; for (const k in t) { const v = t[k]; c += typeof v === 'string' ? +(v === tag) : Object.values(v).filter((x) => x === tag).length; } }
  return c;
}

/** EN AVSTÄNGD STEN: facket får sitt neutrala värde och finns = false; det syns i loggen och i ramens stenarAv. */
export function off(name: string, fack: { finns: boolean; neutral?(): void }): null {
  fack.neutral?.(); fack.finns = false;
  console.log(`[analysator] sten av: ${name}`);
  return null;
}
const STENAR = ['kick', 'bass', 'drop', 'riser', 'character', 'section'] as const;
/** Ramens stenarAv: en bit per avstängd sten (1 kick, 2 bas, 4 drop, 8 uppbyggnad, 16 karaktär, 32 sektion). */
export function stenarAv(f: Fack): number { let m = 0; for (let i = 0; i < STENAR.length; i++) if (!f[STENAR[i]].finns) m |= 1 << i; return m; }
