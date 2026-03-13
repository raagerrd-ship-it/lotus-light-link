

## Ändra från upsert till insert — behåll kalibreringshistorik

### Problem
Nuvarande logik gör `upsert` med `onConflict: 'device_name'`, vilket alltid skriver över den enda raden per enhet. Användaren vill behålla alla kalibreringsrader som historik.

### Databasändring
- Ta bort UNIQUE-constrainten på `device_name` (krävs för att tillåta flera rader per enhet)

### Kodändringar

**`src/lib/lightCalibration.ts`**
- Byt `_upsertCloud` från `.upsert(..., { onConflict })` till `.insert(...)` — varje sparning skapar en ny rad
- `loadCalibrationFromCloud` — hämta senaste raden via `.order('updated_at', { ascending: false }).limit(1)` istället för `.maybeSingle()`

### Resultat
Varje BLE-hastighetstest och latenstest skapar en ny databasrad. Användaren kan se historiken och ta bort gamla poster manuellt.

