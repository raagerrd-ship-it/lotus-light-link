ALTER TABLE public.song_analysis
  ADD COLUMN IF NOT EXISTS energy smallint,
  ADD COLUMN IF NOT EXISTS danceability smallint,
  ADD COLUMN IF NOT EXISTS happiness smallint,
  ADD COLUMN IF NOT EXISTS loudness text;