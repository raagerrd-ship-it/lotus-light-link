/**
 * Fargval ur Sonos-gatewayens albumpalett.
 *
 * MATT 2026-09-07 mot den korande gatewayen: den skickar ALLTID fyra platser,
 * men sallan fyra farger. Extraktorn kor k-means (K=4) i Lab, kastar kluster
 * med for lag kulor for att synas pa LED, och fyller sedan ut till fyra genom
 * att UPPREPA huvudfargen. En typisk palett ar darfor tva distinkta farger i
 * fyra slots:
 *
 *   Heimkoma  [245,63,0] [248,139,88] [245,63,0] [245,63,0]
 *
 * Gamla regeln var "ta [0]" = den dominanta. Tva latar i rad fran samma skiva
 * byter da knappt farg alls. Har valjer vi i stallet den farg som ligger
 * LANGST FRAN foregaende lats farg, matt i Lab (dE ~ perceptuell skillnad).
 *
 * MEN bara bland de farger som fortfarande ar RIKTIGA farger. Utan kulorgolv
 * vinner alltid den blekaste kandidaten -- den ligger langst bort just for att
 * den ar urvattnad -- och en beige ton laser som smutsvit nar lampan dimmar
 * ner den linjart. Mattt exempel: bytet till rgb(181,157,124) ar dE 78.8 mot
 * dE 49.8 for den dominanta, alltsa 58% storre steg, men dess chroma ar 20.9
 * mot 50.6. Det ar fel affar.
 */

/** Kulorgolv i Lab-chroma EFTER gatewayens 2.2x-boost. Under detta ar fargen
 *  for urvattnad for att duga som latens farg, hur olik den an ar. Gatewayens
 *  egen grind slapper igenom ner till ~18, sa 35 behaller ovre tva tredjedelar
 *  av spannet. */
const CHROMA_FLOOR = Number(process.env.LOTUS_COLOR_CHROMA_FLOOR) || 35;

/** En icke-dominant farg maste sla den dominanta med SA har mycket dE for att
 *  vara vard att valja. Utan detta byter vi bort latens identitetsfarg for en
 *  skillnad ogat anda inte ser. */
const MIN_GAIN_DE = Number(process.env.LOTUS_COLOR_MIN_GAIN_DE) || 12;

type RGB = [number, number, number];

const GAMMA = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  GAMMA[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB -> CIE Lab (D65). Samma matematik som gatewayens palette.js. */
function rgbToLab(c: RGB): [number, number, number] {
  const r = GAMMA[Math.max(0, Math.min(255, Math.round(c[0])))];
  const g = GAMMA[Math.max(0, Math.min(255, Math.round(c[1])))];
  const b = GAMMA[Math.max(0, Math.min(255, Math.round(c[2])))];
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0;
  const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: RGB, b: RGB): number {
  const A = rgbToLab(a), B = rgbToLab(b);
  const dL = A[0] - B[0], da = A[1] - B[1], db = A[2] - B[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

function chromaOf(c: RGB): number {
  const L = rgbToLab(c);
  return Math.sqrt(L[1] * L[1] + L[2] * L[2]);
}

function sameColor(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Resultatet av ett val -- `ordered[0]` ar fargen lampan ska lysa med. */
export interface ColorPick {
  ordered: RGB[];
  /** true om vi valde nagon annan an gatewayens dominanta [0]. */
  swapped: boolean;
  /** dE mot foregaende lats farg for den valda, null om ingen foregaende. */
  chosenDe: number | null;
  /** dE som den dominanta [0] hade gett -- for loggen. */
  primaryDe: number | null;
}

/**
 * Sortera om paletten sa att den valda fargen ligger forst. Ovriga behaller
 * sin inbordes ordning, sa UI och show ser samma lista som forut, bara med ny
 * forsta plats.
 *
 * `prev` = fargen lampan lyser med just nu (foregaende lats val). null vid
 * forsta laten efter boot -> vi tar den dominanta som forut.
 */
export function orderPaletteByContrast(palette: RGB[], prev: RGB | null): ColorPick {
  const none: ColorPick = { ordered: palette, swapped: false, chosenDe: null, primaryDe: null };
  if (!Array.isArray(palette) || palette.length === 0) return none;
  if (!prev) return none;

  // Gatewayens utfyllnad gor att samma farg kan sta pa flera platser.
  const distinct: RGB[] = [];
  for (const c of palette) if (!distinct.some((d) => sameColor(d, c))) distinct.push(c);
  if (distinct.length < 2) return none;

  const primary = distinct[0];
  const primaryDe = deltaE(primary, prev);

  // Bara kandidater som fortfarande ar riktiga farger far tavla.
  let best = primary;
  let bestDe = primaryDe;
  for (let i = 1; i < distinct.length; i++) {
    const cand = distinct[i];
    if (chromaOf(cand) < CHROMA_FLOOR) continue;
    const de = deltaE(cand, prev);
    if (de > bestDe + MIN_GAIN_DE) { best = cand; bestDe = de; }
  }

  if (sameColor(best, primary)) {
    return { ordered: palette, swapped: false, chosenDe: primaryDe, primaryDe };
  }

  const ordered = [best, ...palette.filter((c) => !sameColor(c, best))];
  return { ordered, swapped: true, chosenDe: bestDe, primaryDe };
}
