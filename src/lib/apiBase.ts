/**
 * apiBase — Resolves the engine API base URL.
 *
 * The UI is served by a simple static file server (no proxy).
 * API calls go directly to the engine on its own port.
 *
 * Resolution order:
 *  1. VITE_ENGINE_URL env var (full URL, e.g. "http://192.168.1.50:3050")
 *  2. VITE_ENGINE_PORT env var → same hostname, different port
 *  3. Default: same hostname as current page, port 3050
 */

function resolveApiBase(): string {
  // Full override
  const envUrl = import.meta.env.VITE_ENGINE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');

  // Port override
  const envPort = import.meta.env.VITE_ENGINE_PORT;
  const port = envPort || '3050';

  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${port}`;
  }

  return `http://localhost:${port}`;
}

/** Base URL for engine API calls, e.g. "http://192.168.1.50:3050" */
export const apiBase = resolveApiBase();
