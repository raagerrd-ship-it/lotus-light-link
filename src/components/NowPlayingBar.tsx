import { useRef, useEffect, useState } from "react";
import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";
import { getCurrentSection, type SongSection } from "@/lib/sectionLighting";

interface Props {
  nowPlaying: SonosNowPlaying;
  bpm?: number | null;
  accentColor?: [number, number, number];
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  sections?: SongSection[] | null;
}

export default function NowPlayingBar({ nowPlaying, bpm, accentColor, getPosition }: Props) {
  const [r, g, b] = accentColor ?? [255, 255, 255];
  const barRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const dur = nowPlaying.durationMs;
    if (!dur || dur <= 0 || !getPosition) return;

    const tick = () => {
      const pos = getPosition();
      if (pos && barRef.current) {
        const elapsed = performance.now() - pos.receivedAt;
        const fraction = Math.min(1, Math.max(0, (pos.positionMs + elapsed) / dur));
        barRef.current.style.width = `${fraction * 100}%`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [nowPlaying.durationMs, getPosition]);

  return (
    <div className="shrink-0">
      {/* Progress bar — top edge */}
      <div className="h-[2px] bg-border/30 overflow-hidden">
        <div
          ref={barRef}
          className="h-full"
          style={{
            width: '0%',
            backgroundColor: `rgb(${r}, ${g}, ${b})`,
            boxShadow: `0 0 6px rgba(${r},${g},${b},0.5)`,
          }}
        />
      </div>

      <div className="flex items-center gap-3 px-4 py-3">
        {nowPlaying.albumArtUrl && (
          <img
            key={nowPlaying.albumArtUrl}
            src={nowPlaying.albumArtUrl}
            alt="Album art"
            className="w-12 h-12 rounded-xl"
            onError={(e) => {
              const img = e.currentTarget;
              if (img.dataset.fallbackApplied === "1") return;
              img.dataset.fallbackApplied = "1";
              img.src = "/placeholder.svg";
            }}
            style={{
              boxShadow: `0 0 16px rgba(${r},${g},${b},0.4), 0 0 4px rgba(${r},${g},${b},0.2)`,
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate">
            {nowPlaying.trackName}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {nowPlaying.artistName}
          </p>
        </div>
        {bpm != null && (
          <span
            className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground bg-secondary border px-2 py-0.5 rounded-full shrink-0"
            style={{ borderColor: `rgba(${r},${g},${b},0.3)` }}
          >
            {bpm} BPM
          </span>
        )}
      </div>
    </div>
  );
}
