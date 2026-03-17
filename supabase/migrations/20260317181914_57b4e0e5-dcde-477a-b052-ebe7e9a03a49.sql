
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS tick_ms integer DEFAULT 125,
  ADD COLUMN IF NOT EXISTS color_source text DEFAULT 'proxy',
  ADD COLUMN IF NOT EXISTS manual_color jsonb DEFAULT '[255,80,0]'::jsonb;
