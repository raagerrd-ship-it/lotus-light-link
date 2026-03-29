import { useRef, useEffect } from "react";
import { Radio } from "lucide-react";
import type { SonosNowPlaying } from "@/hooks/useSonosNowPlaying";

interface Props {
  nowPlaying: SonosNowPlaying;
  accentColor?: [number, number, number];
  getPosition?: () => { positionMs: number; receivedAt: number } | null;
  nextPrefetched?: boolean;
}

export default function NowPlayingBar({ nowPlaying, accentColor, getPosition, nextPrefetched }: Props) {
  const [r, g, b] = accentColor ?? [255, 255, 255];
  const barRef = useRef<HTMLDivElement>(null);

  // Update width via CSS transition instead of 60fps rAF loop
  // Poll position at ~4fps and let CSS animate the bar smoothly
  useEffect(() => {
    const dur = nowPlaying.durationMs;
    if (!dur || dur <= 0 || !getPosition) return;

    const update = () => {
      const pos = getPosition();
      if (pos && barRef.current) {
        const elapsed = performance.now() - pos.receivedAt;
        const currentMs = pos.positionMs + elapsed;
        const fraction = Math.min(1, Math.max(0, currentMs / dur));
        barRef.current.style.width = `${fraction * 100}%`;
      }
    };
    update();
    const id = setInterval(update, 250); // ~4fps
    return () => clearInterval(id);
  }, [nowPlaying.durationMs, getPosition]);

  return (
    <div className="shrink-0">
      <div className="h-[2px] bg-border/30 overflow-hidden">
        <div
          ref={barRef}
          className="h-full"
          style={{
            width: '0%',
            transition: 'width 300ms linear',
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
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
            {nowPlaying.mediaType === 'radio' && <Radio className="w-3 h-3 shrink-0 text-accent" />}
            {nowPlaying.artistName}
          </p>
        </div>

        {/* Next track */}
        {nowPlaying.nextTrackName && (
          <div className="flex items-center gap-2 ml-auto opacity-50 shrink-0 max-w-[40%]">
            {nowPlaying.nextAlbumArtUrl && (
              <img
                src={nowPlaying.nextAlbumArtUrl}
                alt="Next"
                className="w-8 h-8 rounded-lg"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (img.dataset.fallbackApplied === "1") return;
                  img.dataset.fallbackApplied = "1";
                  img.src = "/placeholder.svg";
                }}
              />
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-foreground truncate">
                {nowPlaying.nextTrackName}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {nowPlaying.nextArtistName}
                {nextPrefetched && (
                  <span className="ml-1 text-green-400">●</span>
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
