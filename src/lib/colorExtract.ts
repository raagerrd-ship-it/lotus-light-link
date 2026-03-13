/**
 * Extract dominant colors from an image URL.
 * Uses an offscreen canvas to sample pixels and k-means-style clustering.
 */

type RGB = [number, number, number];

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function extractColorsFromImage(img: HTMLImageElement, count: number): RGB[] {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    ctx.drawImage(img, 0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();

    for (let i = 0; i < imageData.length; i += 4) {
      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const a = imageData[i + 3];
      if (a < 128) continue;

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 40 || lum > 220) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0;
      if (sat < 0.35) continue;

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

    const scored: { color: RGB; score: number }[] = [];
    for (const bucket of buckets.values()) {
      const avgR = bucket.r / bucket.count;
      const avgG = bucket.g / bucket.count;
      const avgB = bucket.b / bucket.count;
      const max = Math.max(avgR, avgG, avgB);
      const min = Math.min(avgR, avgG, avgB);
      const sat = max > 0 ? (max - min) / max : 0;
      const lum = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;

      if (sat < 0.4 && lum > 60 && lum < 160) continue;

      const score = bucket.count * (sat ** 2) * 4;
      scored.push({ color: [Math.round(avgR), Math.round(avgG), Math.round(avgB)], score });
    }
    scored.sort((a, b) => b.score - a.score);

    const MIN_DIST = 60;
    const palette: RGB[] = [];
    for (const { color } of scored) {
      if (palette.length >= count) break;
      if (palette.every(existing => colorDistance(existing, color) > MIN_DIST)) {
        const [cr, cg, cb] = color;
        const maxC = Math.max(cr, cg, cb);
        const minC = Math.min(cr, cg, cb);
        const mid = (cr + cg + cb) / 3;
        const boostFactor = maxC - minC < maxC * 0.6 ? 2.5 : 1.5;
        palette.push([
          Math.round(Math.min(255, Math.max(0, mid + (cr - mid) * boostFactor))),
          Math.round(Math.min(255, Math.max(0, mid + (cg - mid) * boostFactor))),
          Math.round(Math.min(255, Math.max(0, mid + (cb - mid) * boostFactor))),
        ]);
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

export async function extractDominantColor(
  imageUrl: string
): Promise<[number, number, number] | null> {
  const palette = await extractPalette(imageUrl);
  return palette.length > 0 ? palette[0] : null;
}

export async function extractPalette(
  imageUrl: string,
  count: number = 4
): Promise<RGB[]> {
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
        return colors;
      }
    } catch { /* continue */ }
  }

  console.warn(`[palette] failed after ${Math.round(performance.now() - t0)}ms`);
  return [];
}
