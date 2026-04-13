/**
 * apiBase — Resolves the engine API base URL.
 *
 * The UI is served by a simple static file server.
 * API calls go directly to the engine on its own port.
 *
 * Resolution order:
 *  1. VITE_ENGINE_URL env var (full URL, e.g. "http://192.168.1.50:3050")
 *  2. VITE_ENGINE_PORT env var → same hostname, that port
 *  3. Default: same hostname as current page, current port + 50 (portOffset)
 */

const PORT_OFFSET = 50;

function resolveApiBase(): string {
  // Full override
  const envUrl = import.meta.env.VITE_ENGINE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');

  // Port override
  const envPort = import.meta.env.VITE_ENGINE_PORT;

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    const enginePort = envPort || String(Number(port || '3000') + PORT_OFFSET);
    return `${protocol}//${hostname}:${enginePort}`;
  }

  return `http://localhost:${envPort || '3050'}`;
}

/** Base URL for engine API calls, e.g. "http://192.168.1.50:3050" */
export const apiBase = resolveApiBase();
