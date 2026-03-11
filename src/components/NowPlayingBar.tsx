import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";

interface Props {
  nowPlaying: SonosNowPlaying;
  bpm?: number | null;
  accentColor?: [number, number, number];
  progressFraction?: number;
}

export default function NowPlayingBar({ nowPlaying, bpm, accentColor, progressFraction = 0 }: Props) {
  const [r, g, b] = accentColor ?? [255, 255, 255];

  return (
    <div className="shrink-0">
      {/* Progress bar — top edge */}
      <div className="h-[2px] bg-border/30 overflow-hidden">
        <div
          className="h-full transition-[width] duration-1000 ease-linear"
          style={{
            width: `${progressFraction * 100}%`,
            backgroundColor: `rgb(${r}, ${g}, ${b})`,
            boxShadow: `0 0 6px rgba(${r},${g},${b},0.5)`,
          }}
        />
      </div>

      <div className="flex items-center gap-3 px-4 py-3">
        {nowPlaying.albumArtUrl && (
          <img
            src={nowPlaying.albumArtUrl}
            alt="Album art"
            className="w-12 h-12 rounded-xl"
            crossOrigin="anonymous"
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
