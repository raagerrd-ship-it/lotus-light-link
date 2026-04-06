/**
 * Palette extraction via Lovable Cloud edge function.
 * Pi sends album art URL → gets back top 4 LED-optimized colors.
 * Falls back gracefully if cloud is unreachable.
 */

type RGB = [number, number, number];

// Local cache so we don't re-fetch for the same URL
const cache = new Map<string, RGB[]>();
const CACHE_MAX = 20;

// Edge function URL — set via env or default to Lovable Cloud
const EDGE_URL = process.env.PALETTE_EDGE_URL
  ?? 'https://pwhmgfyaubpawwezwcyd.supabase.co/functions/v1/extract-palette';

const ANON_KEY = process.env.PALETTE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3aG1nZnlhdWJwYXd3ZXp3Y3lkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzE2MzcsImV4cCI6MjA4ODc0NzYzN30.nybHIVidQUQU7EmZMeBXR8CisGRULVZ59eqejcRtvEI';

export async function extractPalette(imageUrl: string, count = 4): Promise<RGB[]> {
  // Check local cache
  const cached = cache.get(imageUrl);
  if (cached) return cached.slice(0, count);

  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ url: imageUrl, count }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[palette] Edge function error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const palette: RGB[] = data.palette ?? [];

    if (palette.length > 0) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(imageUrl, palette);
      console.log(`[palette] ${palette.length} colors via cloud`);
    }

    return palette;
  } catch (err) {
    console.warn(`[palette] Cloud unreachable: ${(err as Error).message}`);
    return [];
  }
}
