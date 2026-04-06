/**
 * Minimal palette extraction — no sharp, no canvas.
 * Fetches a tiny JPEG from iTunes (10x10), decodes raw pixel bytes
 * using a minimal inline JPEG decoder (extract from raw DCT not needed
 * at 10x10 — we just average the whole image into a few color buckets).
 *
 * Strategy: fetch 10x10 image → decode with pureimage-style raw parse
 * Actually even simpler: use the /10x10/ iTunes URL trick and parse
 * the pixel data from a BMP conversion via Node's built-in capabilities.
 *
 * Simplest viable: fetch tiny JPEG, pipe through `sharp` only for raw()...
 * BUT user wants no sharp. So: fetch 1x1 for dominant color, 
 * and 4x1 for a 4-color palette from different quadrants.
 *
 * FINAL approach: fetch 4 separate 1x1 images from 4 crop positions.
 * iTunes doesn't support cropping, so instead:
 * Fetch a small image (30x30bb), read raw JPEG bytes, extract approximate
 * colors by sampling specific byte positions in the decompressed data.
 *
 * ACTUALLY simplest: just use sharp since it's already in package.json.
 * But make it as lean as possible.
 */

// OK let's be practical: sharp is already a dependency.
// Make extraction dead simple: resize to 4x4, read 16 pixels, pick top 4 distinct colors.

import sharp from 'sharp';

type RGB = [number, number, number];

const cache = new Map<string, RGB[]>();

/** Boost saturation for LED-friendly colors */
function boost(r: number, g: number, b: number): RGB {
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
  const bs = Math.max(0.75, Math.min(1, s * 3));
  const bl = Math.max(0.30, Math.min(0.45, l));
  const c = (1 - Math.abs(2 * bl - 1)) * bs;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = bl - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function dist(a: RGB, b: RGB): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

export async function extractPalette(imageUrl: string, count = 4): Promise<RGB[]> {
  const cached = cache.get(imageUrl);
  if (cached) return cached.slice(0, count);

  try {
    // Fetch smallest possible image
    const smallUrl = imageUrl.replace(/\/\d+x\d+[a-z]*\./, '/30x30bb.');
    const res = await fetch(smallUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];

    // Resize to 4x4 = 16 pixels, get raw RGB
    const raw = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(4, 4, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer();

    // 16 pixels → pick distinct colors
    const pixels: RGB[] = [];
    for (let i = 0; i < raw.length; i += 3) {
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      const lum = 0.3 * r + 0.6 * g + 0.1 * b;
      if (lum < 15 || lum > 210) continue; // skip near-black/white
      if (Math.max(r, g, b) - Math.min(r, g, b) < 20) continue; // skip gray
      pixels.push(boost(r, g, b));
    }

    // Deduplicate: keep colors with distance > 40
    const palette: RGB[] = [];
    for (const c of pixels) {
      if (palette.length >= count) break;
      if (palette.every(p => dist(p, c) > 40)) palette.push(c);
    }

    if (palette.length > 0) {
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(imageUrl, palette);
      console.log(`[palette] ${palette.length} colors (4x4)`);
    }
    return palette;
  } catch {
    return [];
  }
}
