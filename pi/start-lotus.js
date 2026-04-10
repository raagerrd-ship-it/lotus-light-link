#!/usr/bin/env node
/**
 * start-lotus.js — Wrapper that starts both engine and frontend
 * Used by Pi Dashboard: node /opt/lotus-light/pi/start-lotus.js
 * Engine runs as child process, frontend in-process (systemd tracks this PID)
 */

import { fork } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const BACKEND_PORT = process.env.BACKEND_PORT ?? '3050';

// Pass PORT → CONFIG_PORT for frontend
process.env.BACKEND_PORT = BACKEND_PORT;
process.env.CONFIG_PORT = process.env.PORT ?? process.env.CONFIG_PORT ?? '3001';

// 1. Fork engine as separate process (dedicated real-time loop)
const engine = fork(join(DIST, 'index.js'), [], {
  env: { ...process.env, BACKEND_PORT },
  execArgv: ['--max-old-space-size=128'],
  stdio: 'inherit',
});

console.log(`[Wrapper] Engine forked (PID ${engine.pid}) on :${BACKEND_PORT}`);

// 2. Wait for engine API, then start frontend
const wait = async () => {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/status`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn('[Wrapper] Engine API not ready after 10s — starting frontend anyway');
};

await wait();

// 3. Import frontend (runs in this process — systemd tracks this PID)
await import(join(DIST, 'frontend.js'));

// 4. Cleanup: kill engine when this process exits
const cleanup = () => {
  console.log('[Wrapper] Shutting down engine...');
  engine.kill('SIGTERM');
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
engine.on('exit', (code) => {
  console.error(`[Wrapper] Engine exited (code ${code}) — shutting down`);
  process.exit(code ?? 1);
});
