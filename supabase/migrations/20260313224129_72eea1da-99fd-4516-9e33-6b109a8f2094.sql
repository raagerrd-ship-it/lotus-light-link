CREATE TABLE public.live_session (
  id text PRIMARY KEY DEFAULT 'default',
  device_name text,
  track_name text,
  artist_name text,
  album_art_url text,
  color_r smallint DEFAULT 0,
  color_g smallint DEFAULT 0,
  color_b smallint DEFAULT 0,
  brightness smallint DEFAULT 0,
  section_type text,
  bpm smallint,
  is_playing boolean DEFAULT false,
  position_ms bigint DEFAULT 0,
  duration_ms bigint DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.live_session ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON public.live_session FOR SELECT USING (true);
CREATE POLICY "Public insert" ON public.live_session FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update" ON public.live_session FOR UPDATE USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.live_session;