/**
 * songIdentity — stabil nyckel per låt för record/replay av ljus-sekvenser.
 *
 * Primär källa: Sonos trackName + artistName (gratis, finns i lifecycle-pollen).
 * Fallback: ACRCloud-fingerprint för källor utan metadata (TV/SPDIF). Den biten
 * kräver rå-ljud-capture som medvetet är utesluten på Pi:n (WiFi-coex-kostnad),
 * så identifyViaAcr är en extension-point som returnerar null tills den byggs.
 */

/** Normalisera till slug: gemener, alfanumeriskt + bindestreck. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Bygg song-key från Sonos-metadata. null om ingen användbar titel finns. */
export function songKeyFromSonos(
  trackName: string | null | undefined,
  artistName: string | null | undefined,
): string | null {
  return songKeyFromParts(trackName, artistName);
}

/** Bygg song-key från valfri (artist, track)-källa (Sonos eller ACRCloud). */
export function songKeyFromParts(
  trackName: string | null | undefined,
  artistName: string | null | undefined,
): string | null {
  if (!trackName) return null;
  const t = slug(trackName);
  if (!t) return null;
  const a = artistName ? slug(artistName) : '';
  return a ? `${a}__${t}` : t;
}

/** Identifiera via ACRCloud från WAV. Returnerar { key, artist, track } eller null. */
export async function identifyViaAcr(
  wav: Buffer,
): Promise<{ key: string; artist: string; track: string } | null> {
  const { identify } = await import('./acrIdentify.js');
  const match = await identify(wav);
  if (!match) return null;
  const key = songKeyFromParts(match.track, match.artist);
  if (!key) return null;
  return { key, artist: match.artist, track: match.track };
}
