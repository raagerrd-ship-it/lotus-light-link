-- Add user_id to device_calibration (nullable for backward compat)
ALTER TABLE device_calibration ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Create user_settings table
CREATE TABLE user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  presets jsonb DEFAULT '{}',
  device_modes jsonb DEFAULT '{}',
  idle_color jsonb DEFAULT NULL,
  active_preset text DEFAULT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- RLS for user_settings
CREATE POLICY "Users can read own settings" ON user_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own settings" ON user_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own settings" ON user_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- Update device_calibration RLS
DROP POLICY IF EXISTS "Public delete" ON device_calibration;
DROP POLICY IF EXISTS "Public insert" ON device_calibration;
DROP POLICY IF EXISTS "Public read" ON device_calibration;
DROP POLICY IF EXISTS "Public update" ON device_calibration;

CREATE POLICY "Auth users read own" ON device_calibration FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Auth users insert own" ON device_calibration FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Auth users update own" ON device_calibration FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Auth users delete own" ON device_calibration FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Anon read" ON device_calibration FOR SELECT TO anon USING (user_id IS NULL);
CREATE POLICY "Anon insert" ON device_calibration FOR INSERT TO anon WITH CHECK (user_id IS NULL);
CREATE POLICY "Anon update" ON device_calibration FOR UPDATE TO anon USING (user_id IS NULL);
CREATE POLICY "Anon delete" ON device_calibration FOR DELETE TO anon USING (user_id IS NULL);