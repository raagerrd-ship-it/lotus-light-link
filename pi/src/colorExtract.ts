/**
 * Palette extraction using sharp — no canvas/browser needed.
 * Resizes image to 32x32, samples pixels, clusters by 4-bit quantization,
 * returns top N saturated colors (same logic as browser version).
 */

import sharp from 'sharp';

type RGB = [number, number, number];

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Boost saturation + clamp luminance for vivid LED colors */
function boostSaturation(r: number, g: number, b: number): RGB {
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
  const boostedS = Math.max(0.75, Math.min(1, s * 3.0));
  const boostedL = Math.max(0.30, Math.min(0.45, l));

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

// Simple LRU cache
const cache = new Map<string, RGB[]>();
const CACHE_MAX = 20;

/**
 * Extract top `count` colors from an image URL.
 * Fetches the image, resizes to 32x32 with sharp, quantizes pixels.
 */
export async function extractPalette(imageUrl: string, count = 4): Promise<RGB[]> {
  const cached = cache.get(imageUrl);
  if (cached && cached.length >= count) return cached.slice(0, count);

  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());

    // Resize to 32x32 and get raw RGB pixels
    const { data, info } = await sharp(buf)
      .resize(32, 32, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Quantize into 4-bit buckets
    const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Skip near-black and near-white
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 20 || lum > 200) continue;

      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const existing = buckets.get(key);
      if (existing) {
        existing.r += r; existing.g += g; existing.b += b; existing.count++;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
    }

    if (buckets.size === 0) return [];

    // Score, filter, boost
    const scored: { color: RGB; score: number }[] = [];
    for (const bucket of buckets.values()) {
      const avgR = Math.round(bucket.r / bucket.count);
      const avgG = Math.round(bucket.g / bucket.count);
      const avgB = Math.round(bucket.b / bucket.count);

      if (Math.max(avgR, avgG, avgB) - Math.min(avgR, avgG, avgB) < 25) continue;

      scored.push({ color: boostSaturation(avgR, avgG, avgB), score: bucket.count });
    }
    scored.sort((a, b) => b.score - a.score);

    const palette: RGB[] = [];
    for (const { color } of scored) {
      if (palette.length >= count) break;
      if (palette.every(existing => colorDistance(existing, color) > 30)) {
        palette.push(color);
      }
    }

    // Cache
    if (palette.length > 0) {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(imageUrl, palette);
    }

    console.log(`[palette] ${palette.length} colors from ${imageUrl.slice(0, 60)}…`);
    return palette;
  } catch (err) {
    console.warn(`[palette] failed: ${(err as Error).message}`);
    return [];
  }
}
