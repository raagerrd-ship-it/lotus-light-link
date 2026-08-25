import { useEffect, useState } from "react";
import { apiBase } from "@/lib/apiBase";

export type LiveData = {
  ble: { connected: number; lastSent: { r: number; g: number; b: number; brightness: number; pct: number } | null };
  live: { inputLevel: number };
  sonos: { playbackState: string | null; volume: number | null };
  engine: { running: boolean; tickMs: number | null; hz: number | null; palette: number[][] };
  beat: {
    locked: boolean; bpm: number; confidence: number; nextBeatMs: number;
    beatErr: number; gridPulses: number; leadMs: number;
  } | null;
};

export type LiveState = { online: boolean; data: LiveData | null };

// EN delad poller mot den magra /api/live (i st f 3 oberoende /api/status-pollar).
// Pausar när fliken är dold; 400 ms medan någon slider dras (setFastUntil).
let state: LiveState = { online: false, data: null };
const subs = new Set<(s: LiveState) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let fastUntil = 0;

export function setLiveFeedFastUntil(atMs: number): void {
  fastUntil = atMs;
}

async function poll() {
  if (document.visibilityState !== "hidden") {
    try {
      const r = await fetch(`${apiBase}/api/live`, { signal: AbortSignal.timeout(3000) });
      const data = r.ok ? await r.json() : null;
      state = data ? { online: true, data } : { online: false, data: state.data };
    } catch {
      state = { online: false, data: state.data };
    }
    subs.forEach(cb => cb(state));
  }
  if (subs.size === 0) { timer = null; return; }
  timer = setTimeout(poll, Date.now() < fastUntil ? 400 : 1000);
}

export function useLiveFeed(): LiveState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!timer) poll();
    return () => { subs.delete(setS); };
  }, []);
  return s;
}
