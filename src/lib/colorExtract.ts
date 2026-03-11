/**
 * Extract the dominant vibrant color from an image URL.
 * Uses an offscreen canvas to sample pixels.
 */

function extractFromImage(img: HTMLImageElement): [number, number, number] | null {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

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

    if (buckets.size === 0) return null;

    let bestScore = 0;
    let bestColor: [number, number, number] = [255, 0, 0];

    for (const bucket of buckets.values()) {
      const avgR = bucket.r / bucket.count;
      const avgG = bucket.g / bucket.count;
      const avgB = bucket.b / bucket.count;
      const max = Math.max(avgR, avgG, avgB);
      const min = Math.min(avgR, avgG, avgB);
      const sat = max > 0 ? (max - min) / max : 0;
      const score = bucket.count * (1 + sat * 2);
      if (score > bestScore) {
        bestScore = score;
        bestColor = [Math.round(avgR), Math.round(avgG), Math.round(avgB)];
      }
    }

    const [br, bg, bb] = bestColor;
    const maxC = Math.max(br, bg, bb);
    const minC = Math.min(br, bg, bb);
    if (maxC > 0 && maxC - minC < maxC * 0.5) {
      const mid = (br + bg + bb) / 3;
      bestColor = [
        Math.round(Math.min(255, Math.max(0, mid + (br - mid) * 1.8))),
        Math.round(Math.min(255, Math.max(0, mid + (bg - mid) * 1.8))),
        Math.round(Math.min(255, Math.max(0, mid + (bb - mid) * 1.8))),
      ];
    }

    return bestColor;
  } catch {
    return null;
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
  // Try direct CORS first
  try {
    const img = await loadImage(imageUrl, true);
    const color = extractFromImage(img);
    if (color) return color;
  } catch {
    // CORS blocked — try proxy
  }

  // Fallback: use a CORS proxy
  try {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
    const img = await loadImage(proxyUrl, true);
    const color = extractFromImage(img);
    if (color) return color;
  } catch {
    // proxy also failed
  }

  return null;
}
