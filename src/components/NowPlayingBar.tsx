import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";

interface Props {
  nowPlaying: SonosNowPlaying;
  bpm?: number | null;
  accentColor?: [number, number, number];
}

export default function NowPlayingBar({ nowPlaying, bpm, accentColor }: Props) {
  const [r, g, b] = accentColor ?? [255, 255, 255];

  return (
    <div className="px-4 py-3 shrink-0">
      <div className="flex items-center gap-3">
        {nowPlaying.albumArtUrl && (
          <img
            src={nowPlaying.albumArtUrl}
            alt="Album art"
            className="w-11 h-11 rounded-lg"
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
          <span className="text-[10px] font-mono font-bold tracking-wider text-muted-foreground bg-secondary px-2 py-0.5 rounded-full shrink-0">
            {bpm} BPM
          </span>
        )}
      </div>
    </div>
  );
}
