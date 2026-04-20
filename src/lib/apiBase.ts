/**
 * apiBase — Resolves the engine API base URL.
 *
 * Port-layout på Pi:n (fast):
 *   3001 = Lotus Lantern UI (denna app, statisk server)
 *   3051 = Lotus Lantern engine (denna app, API)
 *   3002 = Cast Away UI
 *   3052 = Cast Away engine
 *   3003 = Sonos UI
 *   3053 = Sonos engine
 *   (port 3050 finns inte — gammal default, numera felaktig)
 *
 * Resolution order:
 *  1. VITE_ENGINE_URL env var (full URL, e.g. "http://192.168.1.50:3051")
 *  2. VITE_ENGINE_PORT env var → same hostname, that port
 *  3. Same hostname som aktuell sida, (port + 50) — fungerar när UI:t serveras på 3001
 *  4. Om porten inte går att räkna ut (t.ex. Lovable-preview på 443): fallback till 3051
 */

const PORT_OFFSET = 50;
const DEFAULT_ENGINE_PORT = '3051';

function resolveApiBase(): string {
  // Full override
  const envUrl = import.meta.env.VITE_ENGINE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');

  // Port override
  const envPort = import.meta.env.VITE_ENGINE_PORT;

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    // Om sidan serveras utan explicit port (t.ex. https://...lovableproject.com på 443),
    // finns ingen meningsfull +50-mappning → använd DEFAULT_ENGINE_PORT istället.
    const hasExplicitPort = port !== '' && !Number.isNaN(Number(port));
    const enginePort =
      envPort ||
      (hasExplicitPort
        ? String(Number(port) + PORT_OFFSET)
        : DEFAULT_ENGINE_PORT);
    return `${protocol}//${hostname}:${enginePort}`;
  }

  return `http://localhost:${envPort || DEFAULT_ENGINE_PORT}`;
}

/** Base URL for engine API calls, e.g. "http://192.168.1.50:3051" */
export const apiBase = resolveApiBase();
