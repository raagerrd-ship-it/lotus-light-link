import { Music } from "lucide-react";
import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";

interface Props {
  nowPlaying: SonosNowPlaying;
  accentColor: string;
  bpm?: number | null;
}

export default function NowPlayingBar({ nowPlaying, bpm }: Props) {
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
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground truncate">
              {nowPlaying.artistName}
            </p>
            {bpm != null && (
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {bpm} BPM
              </span>
            )}
          </div>
        </div>
        <Music className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
    </div>
  );
}
