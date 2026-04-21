

# Alternativ B: 4 separata profiler lagrade på Pi:n

## Backend (`pi/src/configServer.ts`)

Nya endpoints:
- `GET /api/profiles` → `{ profiles: { Lugn, Normal, Party, Custom }, activePreset }`
- `PUT /api/profiles` → ersätter hela objektet, sparar till `pi/data/profiles.json` via `storage.ts`
- `PUT /api/active-preset` `{ name }` → byter aktiv profil, kallar `engine.setActiveProfile(name)`

Vid serverstart: läs `profiles.json`. Om saknas → seed:a med default `PRESET_CALS` (samma värden som UI:t har idag) och spara. Kalla `engine.setActiveProfile(activePreset)` vid uppstart så Pi:n alltid har en aktiv kalibrering.

`/api/calibration` (PUT) behålls för bakåtkomp men flaggas internt — den uppdaterar nu **aktiv profil** istället för en separat global. GET returnerar fortfarande aktiv profils värden.

## Engine (`pi/src/piEngine.ts`)

Ny metod `setActiveProfile(cal)` som tar ett kalibrerings-objekt och pluggar in det i samma fält som befintlig `setCalibration` redan sätter (gain, bandweights, dynamics, releaseAlpha, gamma, punchWhite, m.m.). Ingen pipeline-ändring — bara en tunn wrapper så `configServer` har en tydlig entry point per profil.

## Frontend (`src/pages/PiMobile.tsx`)

State-omskrivning:
```ts
const [profiles, setProfiles] = useState<Record<string, Cal>>({...PRESET_CALS});
const [activePreset, setActivePreset] = useState("Normal");
const cal = profiles[activePreset];
const setCal = (next) => setProfiles(p => ({...p, [activePreset]: next}));
```

Profil-byte:
```ts
onClick={async () => {
  setActivePreset(name);
  await fetch(`${API}/api/active-preset`, {method:'PUT', body: JSON.stringify({name})});
}}
```
Ingen `setCal({...PRESET_CALS[name]})` — laddar inte default, bara byter pekare till profilens egna värden.

`load()` hämtar `/api/profiles` istället för `/api/calibration` och seed:ar state.

`handleSave()`:
1. PUT `/api/profiles` med hela `profiles`+`activePreset`
2. Övriga globala settings oförändrade (tickMs, mic-device, gamma, idle-color, sonos, auto-tv, mic-gain)
3. Vid inloggad: skriv `profiles` + `active_preset` till `user_settings`

## Supabase-sync

`user_settings.presets` (jsonb) får formen `{Lugn:{...}, Normal:{...}, Party:{...}, Custom:{...}}`. `user_settings.active_preset` får namnet. Befintlig offline-first sync återanvänds — inga schema-ändringar behövs (kolumnerna finns redan).

## Filer

- `pi/src/configServer.ts` — nya endpoints + seed-vid-start
- `pi/src/piEngine.ts` — `setActiveProfile(cal)` wrapper
- `src/pages/PiMobile.tsx` — `profiles`-state, `cal`/`setCal` härledda, profil-byte pushar till Pi, `handleSave` skickar hela objektet, `load()` hämtar `/api/profiles`, Supabase-sync uppdaterad
- `mem://pi/runtime/profile-storage` (ny) — dokumentera 4-profil-modellen

## Migrations-detalj

Första gången en användare kör nya versionen finns ingen `profiles.json`. Vi seedar med `PRESET_CALS`-defaults (samma som UI:t fallback:ar till idag) — användaren förlorar inte sin nuvarande kalibrering eftersom den globala `calibration.json` läses först och pluggas in i `Normal`-profilen om den finns. Övriga 3 profiler får defaults.

