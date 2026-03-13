CREATE TABLE public.device_calibration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name text NOT NULL,
  calibration jsonb NOT NULL DEFAULT '{}'::jsonb,
  ble_min_interval_ms integer,
  ble_speed_results jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_name)
);

ALTER TABLE public.device_calibration ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON public.device_calibration FOR SELECT TO public USING (true);
CREATE POLICY "Public insert" ON public.device_calibration FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Public update" ON public.device_calibration FOR UPDATE TO public USING (true);