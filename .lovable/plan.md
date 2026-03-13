

## Persistera kalibreringsdata i databasen

### Problem
All kalibrering (ljus, BLE-intervall, latens) sparas bara i `localStorage` — försvinner vid byte av enhet/webbläsare.

### Lösning
Spara kalibreringsdata i en databastabell, med `localStorage` som snabb cache.

### Databasschema

Ny tabell `device_calibration`:
- `id` uuid PK (default gen_random_uuid())
- `device_name` text NOT NULL — BLE-enhetsnamn (t.ex. "ELK-BLEDOM")
- `calibration` jsonb NOT NULL — hela `LightCalibration`-objektet
- `ble_min_interval_ms` integer — worst-case BLE-intervall
- `ble_speed_results` jsonb — modeBests-data (`{brightness: 50, color: 80, combined: 80}`)
- `updated_at` timestamptz DEFAULT now()
- UNIQUE constraint på `device_name`

RLS: Publikt läs/skriv (ingen auth i appen idag).

### Kodändringar

**`src/lib/lightCalibration.ts`**
- `saveCalibration()` — skriver till localStorage OCH upsert till `device_calibration` via Supabase
- `loadCalibrationFromCloud(deviceName)` — hämtar från DB, sparar till localStorage
- Ny `getDeviceCalibration(deviceName)` som först kollar localStorage, sedan DB

**`src/lib/bledom.ts`**
- `setBleMinInterval()` — uppdaterar även DB-raden för aktuell enhet

**`src/pages/Calibrate.tsx`**
- Vid mount: ladda kalibrering från DB om `deviceName` finns
- Vid save (alla tabbar): spara till DB med `device_name` som nyckel
- BLE-speed `modeBests` sparas i `ble_speed_results`-kolumnen

### Flöde

```text
Kalibrering klar → saveCalibration()
                   ├── localStorage (snabb cache)
                   └── upsert device_calibration (persistent)

App startar → getDeviceCalibration(bleDeviceName)
              ├── localStorage hit? → använd
              └── miss → hämta från DB → cache i localStorage
```

### Varför `device_name` som nyckel
Kalibrering är per lampa — olika lampor har olika latens, färgåtergivning och BLE-hastighet. Enhetsnamnet identifierar lampan unikt nog.

