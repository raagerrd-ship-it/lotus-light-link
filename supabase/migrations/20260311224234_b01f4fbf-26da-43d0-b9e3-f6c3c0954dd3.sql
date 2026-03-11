CREATE TABLE public.song_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_name text NOT NULL,
  artist_name text NOT NULL,
  bpm integer,
  sections jsonb,
  drops jsonb,
  key text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(track_name, artist_name)
);
ALTER TABLE public.song_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON public.song_analysis FOR SELECT USING (true);
CREATE POLICY "Service insert" ON public.song_analysis FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update" ON public.song_analysis FOR UPDATE USING (true);