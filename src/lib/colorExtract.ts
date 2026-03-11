/**
 * Extract the dominant vibrant color from an image URL.
 * Uses an offscreen canvas to sample pixels.
 */
export async function extractDominantColor(
  imageUrl: string
): Promise<[number, number, number] | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 64; // downsample for speed
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);

        ctx.drawImage(img, 0, 0, size, size);
        const imageData = ctx.getImageData(0, 0, size, size).data;

        // Bucket colors into 4-bit bins (16 bins per channel = 4096 buckets)
        const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();

        for (let i = 0; i < imageData.length; i += 4) {
          const r = imageData[i];
          const g = imageData[i + 1];
          const b = imageData[i + 2];
          const a = imageData[i + 3];
          if (a < 128) continue; // skip transparent

          // Filter out too dark or too light pixels
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum < 30 || lum > 240) continue;

          // Filter out near-grey pixels (low saturation)
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max > 0 ? (max - min) / max : 0;
          if (sat < 0.15) continue;

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

        if (buckets.size === 0) return resolve(null);

        // Find the bucket with the most pixels, weighted by saturation
        let bestScore = 0;
        let bestColor: [number, number, number] = [255, 0, 0];

        for (const bucket of buckets.values()) {
          const avgR = bucket.r / bucket.count;
          const avgG = bucket.g / bucket.count;
          const avgB = bucket.b / bucket.count;
          const max = Math.max(avgR, avgG, avgB);
          const min = Math.min(avgR, avgG, avgB);
          const sat = max > 0 ? (max - min) / max : 0;
          // Score: count * saturation boost
          const score = bucket.count * (1 + sat * 2);
          if (score > bestScore) {
            bestScore = score;
            bestColor = [Math.round(avgR), Math.round(avgG), Math.round(avgB)];
          }
        }

        // Boost saturation for LED visibility
        const [br, bg, bb] = bestColor;
        const maxC = Math.max(br, bg, bb);
        const minC = Math.min(br, bg, bb);
        if (maxC > 0 && maxC - minC < maxC * 0.5) {
          // Increase saturation by pushing channels apart
          const mid = (br + bg + bb) / 3;
          bestColor = [
            Math.round(Math.min(255, Math.max(0, mid + (br - mid) * 1.8))),
            Math.round(Math.min(255, Math.max(0, mid + (bg - mid) * 1.8))),
            Math.round(Math.min(255, Math.max(0, mid + (bb - mid) * 1.8))),
          ];
        }

        resolve(bestColor);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}
