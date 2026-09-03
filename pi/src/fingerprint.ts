/**
 * AKUSTISKT FINGERAVTRYCK — "VAR i inspelningen är vi, just nu?"
 *
 * ── Skillnad mot pi-dmx, dar koden kommer ifran ─────────────────────────────
 * Dar var uppgiften IGENKANNING: vilken av alla lagrade latar ar detta? Har vet
 * Sonos redan vilken lat som spelas, sa uppgiften ar bara POSITION — och den
 * matchas mot EN lats landmarken i stallet for mot ett index over alla. Mycket
 * billigare, och rosterna behover bara racka till for att placera oss i tiden.
 *
 * ── Varfor detta slar energikorskorrelationen ───────────────────────────────
 * Energikurvan ar SLAT, sa korrelationstoppen blir bred: uppmatt spridning ett
 * par hundra ms mellan tva matningar pa samma lat, och en lat som upprepar sig
 * kan ge en falsk topp en hel fras bort. Landmarken ar DISKRETA och specifika
 * (tva frekvenser + deras avstand), sa histogrammet far en skarp topp.
 *
 * Och viktigast: landmarken lagras i SAMMA tidslinje som showen renderas i. En
 * traff sager darfor direkt "det du hor nu ar showens tid X" — vad
 * `recordedFromMs` rakade vara spelar ingen roll, felet finns i bada leden och
 * tar ut sig sjalvt.
 *
 * Ingen låttitel, ingen internetuppkoppling. Vi bygger Shazam-liknande
 * landmärkes-hashar direkt ur den 2048-FFT analysatorn ändå redan räknar:
 * per fingerprint-ruta plockas den starkaste spektraltoppen, och den paras
 * med en tidigare topp → en hash som beskriver (frekvens₁, frekvens₂, Δt).
 * Samma par återkommer varje gång samma inspelning spelas, i samma ordning,
 * med samma avstånd → hashen + tidsstämpeln räcker för att både känna igen
 * låten OCH veta var i den vi är.
 *
 * CPU: ingen extra FFT. Per ruta (var 172 ms) ett svep över ~220 bins.
 */

/** Bandgränser i Hz. En topp per band → toppar sprids över spektrumet i
 *  stället för att basen vinner allt. */
const BAND_HZ = [40, 80, 160, 320, 640, 1280, 2560, 5120];

/** En fingerprint-ruta var 172 ms (~5.8 Hz). Tätare ger fler hashar per låt
 *  (minne) utan att matchningen blir märkbart säkrare. */
export const FRAME_MS = 172;

const HIST = 10;          // ringbuffert av tidigare toppar (≈1.7 s bakåt)
const DT_MIN = 2;         // parbildning: 2–8 rutor bort (0.34–1.4 s)
const DT_MAX = 8;

/** Täta lagringen de första 30 s: fler mål att träffa i startfönstret. */
const DENSE_STORE_MS = 30_000;

/** `store` = ska sparas i minnet. ASYMMETRI: vi genererar alla par (upp till 7
 *  per ruta) för MATCHNING, men sparar bara det första — lagrade hashar blir en
 *  delmängd av de matchade, så minnet är oförändrat medan röstunderlaget blir
 *  ~7×. Under de första 30 s sparas alla par. */
export interface Landmark { hash: number; t: number; store: boolean; }


export class Fingerprinter {
  private acc: Float32Array | null = null;   // max-hold mellan fingerprint-rutor
  private accN = 0;
  private frameStartMs = -1;
  private lo: number[] = [];
  private hi: number[] = [];
  private binHz = 0;
  /** Ring av tidigare rutors toppbin (-1 = ingen topp). */
  private ring = new Int16Array(HIST).fill(-1);
  private ringPos = 0;

  /** Matas varje gång analysatorn har en ny 2048-magnitud. `tMs` är låt-tid
   *  (ms sedan låten började) — INTE väggklocka. Returnerar 0–1 landmärken. */
  push(mag: Float32Array, binHz: number, tMs: number, out: Landmark[]): void {
    if (this.binHz !== binHz) {
      this.binHz = binHz;
      this.lo = []; this.hi = [];
      for (let b = 0; b < BAND_HZ.length - 1; b++) {
        this.lo.push(Math.max(1, Math.round(BAND_HZ[b] / binHz)));
        this.hi.push(Math.min(mag.length, Math.round(BAND_HZ[b + 1] / binHz)));
      }
      this.acc = new Float32Array(this.hi[this.hi.length - 1] + 1);
    }
    const acc = this.acc!;
    if (this.frameStartMs < 0) this.frameStartMs = tMs;
    for (let i = 1; i < acc.length; i++) if (mag[i] > acc[i]) acc[i] = mag[i];
    this.accN++;
    if (tMs - this.frameStartMs < FRAME_MS) return;

    // ── Ny fingerprint-ruta: plocka starkaste toppen (relativt sitt band) ──
    const frameT = this.frameStartMs;
    this.frameStartMs = tMs;
    this.accN = 0;
    let bestBin = -1, bestScore = 0;
    for (let b = 0; b < this.lo.length; b++) {
      const lo = this.lo[b], hi = this.hi[b];
      let sum = 0, peak = 0, peakBin = -1;
      for (let i = lo; i < hi; i++) { sum += acc[i]; if (acc[i] > peak) { peak = acc[i]; peakBin = i; } }
      const mean = sum / Math.max(1, hi - lo);
      // Prominens mot bandets eget snitt → en platt bandvägg ger ingen topp.
      const score = mean > 1e-7 ? peak / mean : 0;
      if (peakBin >= 0 && score > 2 && score > bestScore) { bestScore = score; bestBin = peakBin; }
    }
    acc.fill(0);

    // Para den nya toppen med ALLA tidigare toppar i fönstret → hash
    // (bin₁ 8b | bin₂ 8b | Δt 5b). Första paret lagras, resten är matchning.
    if (bestBin >= 0) {
      const b2 = bestBin & 0xff;
      const dense = frameT < DENSE_STORE_MS;
      let first = true;
      // CPU-TAK: bara de FORSTA paren. MATT pa hardvara: 7 par/ruta drev motorn
      // fran 42 % till 80-98 % CPU -> render-loopen tappade jamn takt och det
      // syntes som FLIMMER, varst vid full styrka. Och asymmetrin gav ingen
      // matbar vinst: konfidens 0.35 med 7 par mot 0.38 med 1 par. Kostnad utan
      // nytta -> tillbaka till fa par. Tat LAGRING forsta 30 s ar kvar (dense),
      // den ar billig och ger fler mal att traffa i startfonstret.
      // MATT: 7 par -> 98 % CPU (fladder), 1 par -> 48 % CPU men igenkanningen
      // tappade (agaren spelade en lard lat som spelades in som ny). 3 par ar
      // mellanlaget: ~3x fler roster an 1, och CPU-marginalen finns (48 %).
      const maxPairs = dense ? 5 : 3;
      let made = 0;
      for (let d = DT_MIN; d <= DT_MAX && made < maxPairs; d++) {
        const prev = this.ring[(this.ringPos - d + HIST * 2) % HIST];
        if (prev < 0) continue;
        out.push({ hash: (prev & 0xff) | (b2 << 8) | (d << 16), t: Math.round(frameT), store: dense || first });
        first = false; made++;
      }
    }

    this.ring[this.ringPos] = bestBin;
    this.ringPos = (this.ringPos + 1) % HIST;
  }

  /** Ny låt börjar → glöm historiken (inga par över låtgränsen). */
  reset(): void {
    this.ring.fill(-1);
    this.frameStartMs = -1;
    this.accN = 0;
    this.acc?.fill(0);
  }
}
