
CREATE TABLE public.calibration_songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  artist text NOT NULL,
  why text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  spotify_uri text,
  votes_up int NOT NULL DEFAULT 0,
  votes_down int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.calibration_songs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read calibration songs"
  ON public.calibration_songs FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can update votes"
  ON public.calibration_songs FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can insert calibration songs"
  ON public.calibration_songs FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Seed recommended songs
INSERT INTO public.calibration_songs (title, artist, why, category) VALUES
  ('Around the World', 'Daft Punk', 'Extremt tydlig och repetitiv four-on-the-floor kick. Guldstandarden för att se om ljuset blinkar exakt på beatet.', 'sync'),
  ('Blue Monday', 'New Order', 'Mekaniska och tunga intro-trummor ger gott om tid att justera utan distraktioner.', 'sync'),
  ('Seven Nation Army', 'The White Stripes', 'Gles och tung bastrumma — lätt att se varje enskild ljusimpuls.', 'sync'),
  ('Sandstorm', 'Darude', 'Perfekt för att testa om systemet hänger med vid högt BPM och snabba fills.', 'dynamics'),
  ('Bohemian Rhapsody', 'Queen', 'Extrema dynamikskiften — från piano till full rock. Perfekt för att testa ljusrespons.', 'dynamics'),
  ('Levels', 'Avicii', 'Tydliga build-ups och drops. Bra för att verifiera att lampan följer energikurvan.', 'dynamics');
