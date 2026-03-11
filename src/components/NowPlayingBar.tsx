import { useEffect, useRef, useState } from "react";
import { Music } from "lucide-react";
import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";

interface Props {
  nowPlaying: SonosNowPlaying;
  accentColor: string;
}

function formatTime(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function NowPlayingBar({ nowPlaying, accentColor }: Props) {
  const [progress, setProgress] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const { positionMs, receivedAt, durationMs } = nowPlaying;
    if (positionMs == null || durationMs == null || durationMs <= 0) return;

    const update = () => {
      const elapsed = performance.now() - receivedAt;
      const current = Math.min(positionMs + elapsed, durationMs);
      setProgress(current / durationMs);
      setRemaining(durationMs - current);
      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [nowPlaying.positionMs, nowPlaying.receivedAt, nowPlaying.durationMs]);

  return (
    <div className="px-4 py-2 shrink-0">
      <div className="flex items-center gap-3">
        {nowPlaying.albumArtUrl && (
          <img
            src={nowPlaying.albumArtUrl}
            alt="Album art"
            className="w-10 h-10 rounded shadow-md"
            crossOrigin="anonymous"
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
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
            -{formatTime(remaining)}
          </span>
          <Music className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
      {/* Progress bar */}
      <div className="mt-1.5 h-[3px] rounded-full bg-secondary/50 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-linear"
          style={{
            width: `${Math.min(100, progress * 100)}%`,
            backgroundColor: accentColor,
            opacity: 0.7,
          }}
        />
      </div>
    </div>
  );
}
