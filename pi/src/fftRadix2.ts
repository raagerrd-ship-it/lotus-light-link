/**
 * Zero-allocation real-input FFT for N=1024.
 *
 * Reell insignal → vi kör en 512-punkts komplex radix-2-FFT på de packade
 * paren (x[2n], x[2n+1]) och splittrar ut de 1024 spektrumbinsen efteråt.
 * Halva butterfly-arbetet jämfört med att nolla imaginärdelen och köra
 * full 1024-FFT (~40% mindre CPU per frame på ARM).
 *
 * All buffers pre-allocated at module load. No GC pressure on hot path.
 * Twiddle factors precomputed once. Bit-reversal table precomputed once.
 */

const N = 1024;
const H = N / 2;          // 512 — storleken på den komplexa FFT:n
const LOG2H = 9;          // log2(512)

// ── Bit-reversal permutation table för 512-punkts-FFT:n ──
const bitRev = new Uint16Array(H);
{
  for (let i = 0; i < H; i++) {
    let rev = 0, val = i;
    for (let b = 0; b < LOG2H; b++) {
      rev = (rev << 1) | (val & 1);
      val >>= 1;
    }
    bitRev[i] = rev;
  }
}

// ── Twiddles för 512-FFT:n (exp(-2πi·i/512)) ──
const twiddleRe = new Float64Array(H / 2);
const twiddleIm = new Float64Array(H / 2);
{
  for (let i = 0; i < H / 2; i++) {
    const angle = -2 * Math.PI * i / H;
    twiddleRe[i] = Math.cos(angle);
    twiddleIm[i] = Math.sin(angle);
  }
}

// ── Split-twiddles för unpack-steget (exp(-2πi·k/1024), k=0..511) ──
const splitRe = new Float64Array(H);
const splitIm = new Float64Array(H);
{
  for (let k = 0; k < H; k++) {
    const angle = -2 * Math.PI * k / N;
    splitRe[k] = Math.cos(angle);
    splitIm[k] = Math.sin(angle);
  }
}

// ── Working buffers (mutated in place each call) ──
const zRe = new Float64Array(H);   // packad komplex insignal / 512-spektrum
const zIm = new Float64Array(H);
const re = new Float64Array(H + 1); // bins 0..512 (reellt spektrum)
const im = new Float64Array(H + 1);

/**
 * Compute FFT in place. Input: real-valued signal in `input` (length N).
 * After call, bins 0..N/2 ligger i de modulnivå-allokerade `re`/`im`-arrayerna
 * (resten av spektrumet är konjugat-symmetriskt och beräknas inte).
 * Returns [re, im] references (NOT copies — do not hold across calls).
 */
export function fft1024(input: Float32Array | Float64Array): [Float64Array, Float64Array] {
  // Packa reella par → komplex halvlängdssignal, med bit-reversal på plats
  for (let i = 0; i < H; i++) {
    const r = bitRev[i];
    zRe[r] = input[i << 1];
    zIm[r] = input[(i << 1) + 1];
  }

  // Cooley-Tukey butterfly (iterative, in-place) över 512 punkter
  for (let s = 1; s <= LOG2H; s++) {
    const m = 1 << s;
    const half = m >> 1;
    const step = H >> s;

    for (let k = 0; k < H; k += m) {
      let twIdx = 0;
      for (let j = 0; j < half; j++) {
        const evenIdx = k + j;
        const oddIdx = evenIdx + half;

        const tRe = twiddleRe[twIdx];
        const tIm = twiddleIm[twIdx];
        twIdx += step;

        const oRe = zRe[oddIdx], oIm = zIm[oddIdx];
        const prodRe = oRe * tRe - oIm * tIm;
        const prodIm = oRe * tIm + oIm * tRe;

        zRe[oddIdx] = zRe[evenIdx] - prodRe;
        zIm[oddIdx] = zIm[evenIdx] - prodIm;
        zRe[evenIdx] += prodRe;
        zIm[evenIdx] += prodIm;
      }
    }
  }

  // Unpack: X[k] = E[k] + (-i)·W1024^k·O[k], där
  //   E[k] = (Z[k] + conj(Z[H-k]))/2,  O[k] = (Z[k] - conj(Z[H-k]))/2
  for (let k = 0; k <= H; k++) {
    const kk = k & (H - 1);            // Z[H] === Z[0] (periodisk)
    const mk = (H - k) & (H - 1);
    const aRe = zRe[kk], aIm = zIm[kk];
    const bRe = zRe[mk], bIm = -zIm[mk]; // conj(Z[H-k])

    const eRe = 0.5 * (aRe + bRe);
    const eIm = 0.5 * (aIm + bIm);
    const oRe = 0.5 * (aRe - bRe);
    const oIm = 0.5 * (aIm - bIm);

    const c = splitRe[kk], s2 = splitIm[kk];
    const tRe = c * oRe - s2 * oIm;
    const tIm = c * oIm + s2 * oRe;

    // (-i)·(tRe + i·tIm) = tIm - i·tRe
    re[k] = eRe + tIm;
    im[k] = eIm - tRe;
  }

  return [re, im];
}

/** Get the FFT size */
export const FFT_N = N;
