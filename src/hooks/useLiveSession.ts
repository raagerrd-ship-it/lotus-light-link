import { useEffect, useRef, useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface MasterDebugState {
  bleConnected?: boolean;
  bleDeviceName?: string | null;
  bleWritesPerSec?: number;
  bleDropsPerSec?: number;
  bleLastWriteMs?: number;
  e2eMs?: number;
  rmsMs?: number;
  smoothMs?: number;
  bleCallMs?: number;
  totalTickMs?: number;
  sonosConnected?: boolean;
  sonosRtt?: number;
  syncMode?: 'mic';
  bleMinIntervalMs?: number;
  maxBrightness?: number;
  dynamicDamping?: number;
  attackAlpha?: number;
  releaseAlpha?: number;
  gainMode?: string;
  sonosVolume?: number | null;
}

export interface LiveSessionState {
  device_name?: string | null;
  track_name?: string | null;
  artist_name?: string | null;
  album_art_url?: string | null;
  color_r: number;
  color_g: number;
  color_b: number;
  brightness: number;
  section_type?: string | null;
  bpm?: number | null;
  is_playing: boolean;
  position_ms: number;
  duration_ms: number;
  debug_state?: MasterDebugState | null;
}

const SESSION_ID = "default";

/** Master: writes live status to DB ~2x/sec */
export function useLiveSessionWriter() {
  const pendingRef = useRef<Partial<LiveSessionState> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flush = useCallback(async () => {
    const data = pendingRef.current;
    if (!data) return;
    pendingRef.current = null;

    const row = { id: SESSION_ID, ...data, updated_at: new Date().toISOString() };
    const { error } = await supabase
      .from("live_session" as any)
      .upsert(row as any, { onConflict: "id" });

    if (error) console.warn("[LiveSession] write error", error.message);
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(flush, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      flush();
    };
  }, [flush]);

  const update = useCallback((state: Partial<LiveSessionState>) => {
    pendingRef.current = { ...(pendingRef.current ?? {}), ...state };
  }, []);

  return { update };
}

/** Monitor: subscribes to realtime changes */
export function useLiveSessionMonitor() {
  const [state, setState] = useState<LiveSessionState | null>(null);
  const stateRef = useRef<LiveSessionState | null>(null);

  // Merge helper: never go from valid state → null
  const mergeState = useCallback((incoming: any) => {
    if (!incoming) return;
    const next = { ...(stateRef.current ?? {}), ...incoming } as LiveSessionState;
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    supabase
      .from("live_session" as any)
      .select("*")
      .eq("id", SESSION_ID)
      .single()
      .then(({ data }) => {
        if (data) mergeState(data);
      });
  }, [mergeState]);

  useEffect(() => {
    const channel = supabase
      .channel("live_session_monitor")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "live_session", filter: `id=eq.${SESSION_ID}` },
        (payload) => mergeState(payload.new)
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "live_session", filter: `id=eq.${SESSION_ID}` },
        (payload) => mergeState(payload.new)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [mergeState]);

  return state;
}
