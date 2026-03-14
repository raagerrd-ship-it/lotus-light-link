
-- Remove kick and kickT fields from all energy_curve samples
UPDATE public.song_analysis
SET energy_curve = (
  SELECT jsonb_agg(
    sample - 'kick' - 'kickT'
  )
  FROM jsonb_array_elements(energy_curve::jsonb) AS sample
)
WHERE energy_curve IS NOT NULL;
