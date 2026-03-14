import { useState, useEffect, useCallback } from "react";
import { ThumbsUp, ThumbsDown, Lightbulb, Music } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface CalibrationSong {
  id: string;
  title: string;
  artist: string;
  why: string;
  category: string;
  votes_up: number;
  votes_down: number;
}

const CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  sync: { label: 'Synk-kalibrering', emoji: '🎯' },
  dynamics: { label: 'Dynamik-kalibrering', emoji: '📊' },
  general: { label: 'Allmänt', emoji: '🎵' },
};

export default function CalibrationTips({ activeCategory }: { activeCategory?: string }) {
  const [songs, setSongs] = useState<CalibrationSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [voted, setVoted] = useState<Record<string, 'up' | 'down'>>(() => {
    try { return JSON.parse(localStorage.getItem('cal_votes') || '{}'); } catch { return {}; }
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    supabase
      .from('calibration_songs')
      .select('*')
      .order('votes_up', { ascending: false })
      .then(({ data }) => {
        setSongs((data as CalibrationSong[]) ?? []);
        setLoading(false);
      });
  }, []);

  const vote = useCallback(async (id: string, direction: 'up' | 'down') => {
    const prev = voted[id];
    if (prev === direction) return; // already voted this way

    const song = songs.find(s => s.id === id);
    if (!song) return;

    // Optimistic update
    const delta = {
      votes_up: song.votes_up + (direction === 'up' ? 1 : 0) - (prev === 'up' ? 1 : 0),
      votes_down: song.votes_down + (direction === 'down' ? 1 : 0) - (prev === 'down' ? 1 : 0),
    };

    setSongs(prev => prev.map(s => s.id === id ? { ...s, ...delta } : s));
    const newVoted = { ...voted, [id]: direction };
    setVoted(newVoted);
    localStorage.setItem('cal_votes', JSON.stringify(newVoted));

    await supabase
      .from('calibration_songs')
      .update(delta)
      .eq('id', id);
  }, [voted, songs]);

  // Filter by active category if provided
  const filtered = activeCategory
    ? songs.filter(s => s.category === activeCategory)
    : songs;

  const grouped = filtered.reduce((acc, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {} as Record<string, CalibrationSong[]>);

  if (loading) return null;
  if (songs.length === 0) return null;

  return (
    <div className="border border-border/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-secondary/50 hover:bg-secondary/70 transition-colors text-left"
      >
        <Lightbulb className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
        <span className="text-xs font-bold text-foreground/80 flex-1">
          Rekommenderade låtar för kalibrering
        </span>
        <span className="text-[10px] text-muted-foreground">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 space-y-3">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Dessa låtar har tydliga beats och dynamik som gör kalibreringen enklare.
            Rösta på de som fungerar bäst!
          </p>

          {Object.entries(grouped).map(([cat, catSongs]) => {
            const info = CATEGORY_LABELS[cat] || CATEGORY_LABELS.general;
            return (
              <div key={cat}>
                <p className="text-[10px] font-bold text-foreground/60 mb-1">
                  {info.emoji} {info.label}
                </p>
                <div className="space-y-1.5">
                  {catSongs.map((song) => {
                    const myVote = voted[song.id];
                    const score = song.votes_up - song.votes_down;
                    return (
                      <div key={song.id} className="border border-border/20 rounded-md px-2.5 py-2 bg-background/50">
                        <div className="flex items-start gap-2">
                          <Music className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">
                              {song.title}
                              <span className="text-muted-foreground font-normal"> — {song.artist}</span>
                            </p>
                            <p className="text-[10px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                              {song.why}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => vote(song.id, 'up')}
                              className={`p-1 rounded transition-colors ${
                                myVote === 'up'
                                  ? 'text-primary bg-primary/10'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                              title="Bra för kalibrering"
                            >
                              <ThumbsUp className="w-3 h-3" />
                            </button>
                            <span className={`text-[10px] font-mono min-w-[1.5rem] text-center ${
                              score > 0 ? 'text-primary' : score < 0 ? 'text-destructive' : 'text-muted-foreground'
                            }`}>
                              {score > 0 ? `+${score}` : score}
                            </span>
                            <button
                              onClick={() => vote(song.id, 'down')}
                              className={`p-1 rounded transition-colors ${
                                myVote === 'down'
                                  ? 'text-destructive bg-destructive/10'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                              title="Fungerade inte bra"
                            >
                              <ThumbsDown className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <p className="text-[10px] text-muted-foreground/60 italic">
            💡 Tips: Spela låten på Sonos innan du börjar kalibreringen.
          </p>
        </div>
      )}
    </div>
  );
}
