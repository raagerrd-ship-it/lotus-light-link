#!/usr/bin/env node
/**
 * Lotus Light Link — Frontend server
 * 
 * Serves the web UI (static files from dist/) on the user-facing port
 * and proxies /api/* requests to the backend engine process.
 */

import { createServer, request as httpRequest } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Pi Control Center sets PORT + ENGINE_PORT; legacy uses CONFIG_PORT/BACKEND_PORT
const PORT = Number(process.env.PORT ?? process.env.CONFIG_PORT ?? 3001);
const BACKEND_PORT = Number(process.env.ENGINE_PORT ?? process.env.BACKEND_PORT ?? 3050);
const WEB_DIST = join(__dirname, '..', '..', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};

const indexHtml = existsSync(join(WEB_DIST, 'index.html'))
  ? readFileSync(join(WEB_DIST, 'index.html'))
  : null;

if (!indexHtml) {
  console.error(`[Frontend] ⚠ No web dist at ${WEB_DIST} — build the web app first`);
}

console.log(`[Frontend] Serving UI on :${PORT} → backend :${BACKEND_PORT}`);

const server = createServer((req, res) => {
  const url = req.url ?? '/';

  // --- Proxy /api/* to backend ---
  if (url.startsWith('/api/')) {
    const proxyReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: BACKEND_PORT,
        path: url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` },
      },
      (proxyRes) => {
        // Add CORS headers
        res.writeHead(proxyRes.statusCode ?? 502, {
          ...proxyRes.headers,
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'Content-Type',
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend unavailable' }));
    });

    req.pipe(proxyReq);
    return;
  }

  // --- OPTIONS preflight ---
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type',
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    });
    res.end();
    return;
  }

  // --- Serve SPA ---
  if (indexHtml) {
    const safePath = url.split('?')[0].split('#')[0];

    // Allow static assets (JS, CSS, images, fonts, manifest, sw)
    const isAsset = safePath.startsWith('/assets/') ||
      safePath.startsWith('/manifest') ||
      safePath.startsWith('/sw.') ||
      safePath.startsWith('/tick-worker') ||
      safePath.startsWith('/favicon') ||
      /\.(js|css|png|jpg|svg|ico|woff|woff2|webp|json|webmanifest)$/.test(safePath);

    if (isAsset) {
      const filePath = join(WEB_DIST, safePath);
      if (filePath.startsWith(WEB_DIST) && existsSync(filePath)) {
        try {
          const stat = statSync(filePath);
          if (stat.isFile()) {
            const ext = extname(filePath);
            const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
            const content = readFileSync(filePath);
            res.writeHead(200, {
              'Content-Type': mime,
              'Cache-Control': 'public, max-age=31536000, immutable',
            });
            res.end(content);
            return;
          }
        } catch {}
      }
    }

    // All other routes → serve SPA index.html
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(indexHtml);
    return;
  }

  // No dist available
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Web UI not built' }));
});

server.listen(PORT, () => {
  console.log(`[Frontend] ✓ Listening on :${PORT}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('[Frontend] Shutting down...');
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
