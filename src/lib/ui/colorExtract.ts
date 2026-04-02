/**
 * Extract dominant colors from an image URL.
 * Uses an offscreen canvas to sample pixels and k-means-style clustering.
 */

type RGB = [number, number, number];

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Boost saturation for vivid LED-friendly colors.
 *  Converts to HSL, boosts S by up to 2x, clamps L to 50-80% for bright pastels. */
function boostSaturation(r: number, g: number, b: number): RGB {
  // RGB → HSL
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  const l = (max + min) / 2;

  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta + 6) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
  }

  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  // Boost: push saturation toward 1.0, enforce minimum so we never get white/gray
  const boostedS = Math.max(0.75, Math.min(1, s * 3.0));
  const boostedL = Math.max(0.30, Math.min(0.45, l));

  // HSL → RGB
  const c = (1 - Math.abs(2 * boostedL - 1)) * boostedS;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = boostedL - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

// Reusable offscreen canvas for palette extraction (avoids DOM element creation per call)
let _extractCanvas: HTMLCanvasElement | null = null;
function getExtractCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (!_extractCanvas) _extractCanvas = document.createElement("canvas");
  _extractCanvas.width = size;
  _extractCanvas.height = size;
  const ctx = _extractCanvas.getContext("2d");
  return ctx ? { canvas: _extractCanvas, ctx } : null;
}

function extractColorsFromImage(img: HTMLImageElement, count: number): RGB[] {
  try {
    const size = 64;
    const result = getExtractCanvas(size);
    if (!result) return [];
    const { ctx } = result;

    ctx.drawImage(img, 0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();

    for (let i = 0; i < imageData.length; i += 4) {
      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const a = imageData[i + 3];
      if (a < 128) continue;

      // Skip near-black and near-white
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 20 || lum > 200) continue;

      // Quantize to 4-bit per channel buckets
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const existing = buckets.get(key);
      if (existing) {
        existing.r += r;
        existing.g += g;
        existing.b += b;
        existing.count++;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
    }

    if (buckets.size === 0) return [];

    // Score by pixel count, filter low-chroma, boost saturation for LED use
    const scored: { color: RGB; score: number }[] = [];
    for (const bucket of buckets.values()) {
      const avgR = Math.round(bucket.r / bucket.count);
      const avgG = Math.round(bucket.g / bucket.count);
      const avgB = Math.round(bucket.b / bucket.count);

      // Skip pure grays (very low chroma)
      const max = Math.max(avgR, avgG, avgB);
      const min = Math.min(avgR, avgG, avgB);
      if (max - min < 45) continue;

      // Boost saturation for vivid LED colors
      const boosted = boostSaturation(avgR, avgG, avgB);
      scored.push({ color: boosted, score: bucket.count });
    }
    scored.sort((a, b) => b.score - a.score);

    const MIN_DIST = 40;
    const palette: RGB[] = [];
    for (const { color } of scored) {
      if (palette.length >= count) break;
      if (palette.every(existing => colorDistance(existing, color) > MIN_DIST)) {
        palette.push(color);
      }
    }

    return palette;
  } catch {
    return [];
  }
}

/** Load image with a timeout (default 3s) */
function loadImage(url: string, crossOrigin: boolean, timeoutMs = 3000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, timeoutMs);
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("load failed")); };
    img.src = url;
  });
}

/** Fetch with AbortController timeout */
function fetchWithTimeout(url: string, timeoutMs = 3000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { mode: 'cors', signal: ac.signal }).finally(() => clearTimeout(timer));
}


// --- Palette cache (LRU, max 20 entries) ---
const paletteCache = new Map<string, RGB[]>();
const CACHE_MAX = 20;

function cacheSet(url: string, colors: RGB[]) {
  if (paletteCache.size >= CACHE_MAX) {
    const oldest = paletteCache.keys().next().value;
    if (oldest) paletteCache.delete(oldest);
  }
  paletteCache.set(url, colors);
}

/** Return cached palette for a URL, or null if not cached. */
export function getCachedPalette(url: string): RGB[] | null {
  return paletteCache.get(url) ?? null;
}

/** Pre-fetch and cache palette for a URL (fire-and-forget). */
export function prefetchPalette(url: string, count: number = 1): void {
  if (paletteCache.has(url)) return;
  extractPalette(url, count).then((colors) => {
    if (colors.length > 0) cacheSet(url, colors);
  }).catch(() => {});
}

export async function extractPalette(
  imageUrl: string,
  count: number = 4
): Promise<RGB[]> {
  // Check cache first
  const cached = paletteCache.get(imageUrl);
  if (cached && cached.length >= count) return cached.slice(0, count);
  const t0 = performance.now();
  const isLocal = imageUrl.startsWith('http://localhost') || imageUrl.startsWith('http://127.');

  // For local URLs, try blob-fetch first (most reliable, avoids canvas CORS taint)
  if (isLocal) {
    try {
      const res = await fetchWithTimeout(imageUrl, 2000);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        try {
          const img = await loadImage(blobUrl, false, 2000);
          const colors = extractColorsFromImage(img, count);
          if (colors.length > 0) {
            console.log(`[palette] local blob ${Math.round(performance.now() - t0)}ms, ${colors.length} colors`);
            cacheSet(imageUrl, colors);
            return colors;
          }
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch { /* continue */ }
  }

  // Try direct CORS load (fast for external URLs with proper headers)
  try {
    const img = await loadImage(imageUrl, true, 3000);
    const colors = extractColorsFromImage(img, count);
    if (colors.length > 0) {
      console.log(`[palette] direct ${Math.round(performance.now() - t0)}ms, ${colors.length} colors`);
      cacheSet(imageUrl, colors);
      return colors;
    }
  } catch { /* continue */ }

  // Fallback: fetch as blob
  if (!isLocal) {
    try {
      const res = await fetchWithTimeout(imageUrl, 3000);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        try {
          const img = await loadImage(blobUrl, false, 2000);
          const colors = extractColorsFromImage(img, count);
          if (colors.length > 0) {
            console.log(`[palette] blob ${Math.round(performance.now() - t0)}ms, ${colors.length} colors`);
            cacheSet(imageUrl, colors);
            return colors;
          }
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch { /* continue */ }
  }

  // Last resort: CORS proxy (only for non-local URLs)
  if (!isLocal) {
    try {
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
      const img = await loadImage(proxyUrl, true, 4000);
      const colors = extractColorsFromImage(img, count);
      if (colors.length > 0) {
        console.log(`[palette] proxy ${Math.round(performance.now() - t0)}ms, ${colors.length} colors`);
        cacheSet(imageUrl, colors);
        return colors;
      }
    } catch { /* continue */ }
  }

  console.warn(`[palette] failed after ${Math.round(performance.now() - t0)}ms`);
  return [];
}
