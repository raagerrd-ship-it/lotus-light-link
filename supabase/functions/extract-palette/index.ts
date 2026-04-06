const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// @ts-ignore - npm import
import * as jpegJs from "npm:jpeg-js@0.4.4";
// @ts-ignore - npm import  
import { PNG } from "npm:pngjs@7.0.0";

type RGB = [number, number, number];

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

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

function extractFromRGBA(data: Uint8Array, pixelCount: number, count: number): RGB[] {
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  
  // Sample every Nth pixel to keep it fast (target ~256 samples)
  const step = Math.max(1, Math.floor(pixelCount / 256)) * 4;
  
  for (let i = 0; i < data.length; i += step) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 20 || lum > 200) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) { e.r += r; e.g += g; e.b += b; e.count++; }
    else buckets.set(key, { r, g, b, count: 1 });
  }

  const scored: { color: RGB; score: number }[] = [];
  for (const b of buckets.values()) {
    const ar = Math.round(b.r / b.count), ag = Math.round(b.g / b.count), ab = Math.round(b.b / b.count);
    if (Math.max(ar, ag, ab) - Math.min(ar, ag, ab) < 25) continue;
    scored.push({ color: boostSaturation(ar, ag, ab), score: b.count });
  }
  scored.sort((a, b) => b.score - a.score);

  const palette: RGB[] = [];
  for (const { color } of scored) {
    if (palette.length >= count) break;
    if (palette.every(p => colorDistance(p, color) > 30)) palette.push(color);
  }
  return palette;
}

function decodeImage(buf: Uint8Array, contentType: string): { data: Uint8Array; width: number; height: number } | null {
  try {
    if (contentType.includes("png")) {
      const png = PNG.sync.read(Buffer.from(buf));
      return { data: new Uint8Array(png.data), width: png.width, height: png.height };
    }
    // Default: try JPEG
    const jpg = jpegJs.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { data: jpg.data, width: jpg.width, height: jpg.height };
  } catch {
    return null;
  }
}

// In-memory cache
const cache = new Map<string, RGB[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url, count = 4 } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Missing url" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check cache
    const cached = cache.get(url);
    if (cached) {
      return new Response(JSON.stringify({ palette: cached.slice(0, count), cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch image
    const imgRes = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!imgRes.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch image", status: imgRes.status }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contentType = imgRes.headers.get("content-type") ?? "";
    const imgBuf = new Uint8Array(await imgRes.arrayBuffer());
    const decoded = decodeImage(imgBuf, contentType);

    if (!decoded) {
      return new Response(JSON.stringify({ error: "Failed to decode image" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const palette = extractFromRGBA(decoded.data, decoded.width * decoded.height, count);

    if (palette.length > 0) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(url, palette);
    }

    return new Response(JSON.stringify({ palette }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
