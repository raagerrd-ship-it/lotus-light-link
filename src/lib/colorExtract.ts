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
      if (lum < 20 || lum > 245) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0;
      if (sat < 0.08) continue;

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

    // Score and sort buckets
    const scored: { color: RGB; score: number }[] = [];
    for (const bucket of buckets.values()) {
      const avgR = bucket.r / bucket.count;
      const avgG = bucket.g / bucket.count;
      const avgB = bucket.b / bucket.count;
      const max = Math.max(avgR, avgG, avgB);
      const min = Math.min(avgR, avgG, avgB);
      const sat = max > 0 ? (max - min) / max : 0;
      const score = bucket.count * (1 + sat * 2);
      scored.push({ color: [Math.round(avgR), Math.round(avgG), Math.round(avgB)], score });
    }
    scored.sort((a, b) => b.score - a.score);

    // Pick top colors that are visually distinct (min distance 60)
    const MIN_DIST = 60;
    const palette: RGB[] = [];
    for (const { color } of scored) {
      if (palette.length >= count) break;
      if (palette.every(existing => colorDistance(existing, color) > MIN_DIST)) {
        // Boost saturation
        const [br, bg, bb] = color;
        const maxC = Math.max(br, bg, bb);
        const minC = Math.min(br, bg, bb);
        if (maxC > 0 && maxC - minC < maxC * 0.5) {
          const mid = (br + bg + bb) / 3;
          palette.push([
            Math.round(Math.min(255, Math.max(0, mid + (br - mid) * 1.8))),
            Math.round(Math.min(255, Math.max(0, mid + (bg - mid) * 1.8))),
            Math.round(Math.min(255, Math.max(0, mid + (bb - mid) * 1.8))),
          ]);
        } else {
          palette.push(color);
        }
      }
    }

    return palette;
  } catch {
    return [];
  }
}

function loadImage(url: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load failed"));
    img.src = url;
  });
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
  // Try direct CORS first
  try {
    const img = await loadImage(imageUrl, true);
    const colors = extractColorsFromImage(img, count);
    if (colors.length > 0) return colors;
  } catch {
    // CORS blocked — try proxy
  }

  // Fallback: use a CORS proxy
  try {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
    const img = await loadImage(proxyUrl, true);
    const colors = extractColorsFromImage(img, count);
    if (colors.length > 0) return colors;
  } catch {
    // proxy also failed
  }

  return [];
}
