

# Valfri inloggning för molnsynk

## Koncept
Appen fungerar 100% offline via localStorage som default. En diskret "Logga in"-knapp i headern låter användaren autentisera sig med Google. När inloggad synkas kalibrering, presets, enhetslägen och vilofärg till databasen — kopplade till användarens konto.

## Databasändringar

### Lägg till `user_id` på `device_calibration`
Nullable kolumn så befintlig data inte bryts. Ny RLS: inloggade användare ser bara sin egen data, anonyma kan fortfarande läsa/skriva (bakåtkompatibilitet under övergången).

```sql
ALTER TABLE device_calibration ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
-- Uppdatera RLS till att inkludera user_id-filter för inloggade
```

### Ny tabell `user_settings`
Synkar presets, device modes och idle color per användare.

```sql
CREATE TABLE user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  presets jsonb DEFAULT '{}',
  device_modes jsonb DEFAULT '{}',
  idle_color jsonb DEFAULT NULL,
  active_preset text DEFAULT NULL,
  updated_at timestamptz DEFAULT now()
);
-- RLS: användare kan bara läsa/skriva sin egen rad
```

## Kodändringar

| Fil | Ändring |
|-----|---------|
| `calibrationCloud.ts` | Inkludera `user_id` i upsert/load om inloggad. Synka presets/device modes/idle color till `user_settings`. |
| `Index.tsx` | Ta bort `installCloudSync()` vid modulnivå. Installera cloud sync villkorligt efter inloggning. Lägg till Google-login-knapp i headern. Vid inloggning: ladda alla inställningar från molnet. |
| `App.tsx` | Lägg till auth-state-lyssnare (`onAuthStateChange`) i en context/provider. |
| Ny: `src/hooks/useAuth.ts` | Hook som exponerar `user`, `signIn`, `signOut`. |
| Ny: `src/components/AuthButton.tsx` | Kompakt login/logout-knapp (Google-ikon eller avatar). |
| `lightCalibration.ts` | Ingen ändring — förblir localStorage-baserad. Cloud-hooken triggar synk separat. |

## UI-flöde

```text
┌──────────────────────────────────────┐
│ 🔵 ELK-BLEDOM [+]  A B C  ⚙ 👤 ⏻  │  ← 👤 = logga in / avatar
└──────────────────────────────────────┘
```

- **Ej inloggad**: Liten person-ikon → klick → Google OAuth
- **Inloggad**: Liten avatar-cirkel → klick → "Logga ut" dropdown
- Vid inloggning laddas senaste kalibrering + presets + device modes från molnet och skriver över localStorage
- Vid utloggning förblir localStorage-data kvar (offline fortsätter fungera)

## Synklogik

1. **Inloggning sker** → ladda `user_settings` + senaste `device_calibration` per enhet → skriv till localStorage
2. **Ändringar medan inloggad** → spara till localStorage + upsert till molnet (befintlig cloud hook + ny settings-synk)
3. **Ej inloggad** → enbart localStorage, ingen molnkontakt

