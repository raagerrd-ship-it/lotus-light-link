ALTER TABLE public.song_analysis ADD COLUMN IF NOT EXISTS dynamic_range jsonb DEFAULT NULL;
ALTER TABLE public.song_analysis ADD COLUMN IF NOT EXISTS transitions jsonb DEFAULT NULL;
ALTER TABLE public.song_analysis ADD COLUMN IF NOT EXISTS beat_strengths jsonb DEFAULT NULL;