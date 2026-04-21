

# Separera attack och release i Mjukhet-sektionen

## Vad ändras konceptuellt

Idag: **Mjukhet** = en slider som bara styr release (fall). Attack (rise) är låst till 1.0 (omedelbar).

Nytt: **Två slidrar** under "Mjukhet"-rubriken:
- **Attack** (0–100, default 100 = omedelbar) — hur snabbt ljuset stiger när musiken slår till
- **Release** (0–100, default = nuvarande Mjukhet-värde) — hur snabbt ljuset faller (oförändrad logik, bara byter namn från "Mjukhet")

Båda mappar via samma exponentiella kurva (`1.0 - 0.995 * t^0.7`) till en alpha 0.005–1.0. Lägre värde = mjukare.

## Per-profil defaults (förslag)

| Profil  | Attack | Release |
|---------|--------|---------|
| Lugn    | 70     | 75 (oförändrad) |
| Normal  | 100    | 30 |
| Party   | 100    | 5  |
| Custom  | 100    | 0  |

Lugn får mjukare attack (ingen poppighet), de övriga behåller skarp attack.

## Filer

**`src/pages/PiMobile.tsx`**
- `Cal`-typen: lägg till `attack: number` (behåll `softness` men döp om semantiskt till release i UI:t — internt fält kan heta `softness` för bakåtkomp eller bytas till `release`).
- `PRESET_CALS`: lägg till `attack`-värden enligt tabellen.
- `softnessToParams` → byt namn till `softnessToAlpha(s)` som returnerar bara `releaseAlpha` (smoothing-fältet kan tas bort, det används inte längre).
- Ny `attackToAlpha(a)` med samma kurva.
- `SLIDER_CONFIG`: byt "Mjukhet" → "Release", lägg till "Attack" precis ovanför.
- `handleSave` → skicka både `attackAlpha` och `releaseAlpha` per profil.
- `mapStoredToCal` (load) → reverse-mappa både `attackAlpha` och `releaseAlpha` tillbaka till UI-värden.

**`pi/src/configServer.ts`**
- `ProfileCal`-typen: lägg till `attackAlpha: number`.
- `DEFAULT_PROFILES`: lägg till `attackAlpha`-värden härledda från attack-defaults ovan.
- Endpoints behöver ingen schema-ändring (fältet flyter bara igenom i jsonb).

**`pi/src/piEngine.ts`**
- `attackAlpha` finns redan i `LightCalibration` och `TickConstants` — **inget engine-arbete behövs**. Den läses redan från `cal.attackAlpha` på rad 54 och används i `tickInner` rad 644. Idag är värdet bara alltid 1.0; nu kommer det vara variabelt.

**`mem://pi/ui/softness-slider-curve`**
- Uppdatera memory: kurvan används nu för BÅDE attack och release.

## Migrationer

- Befintliga `profiles.json` har inget `attackAlpha`-fält → load-mappningen defaultar till 1.0 (= 100 i UI) → identiskt beteende som idag tills användaren rör Attack-slidern.
- Sparade kalibreringar i Supabase `user_settings.presets` påverkas inte (jsonb tar nya fält gratis).

## Visuell layout i ProfileSettingsView

```text
─── Mjukhet ───────────────
Attack       [====●====] 100
0 = mjuk rise, 100 = omedelbar
Release      [==●======]  30
0 = rått fall, 100 = mycket mjukt
```

Rubriken "Mjukhet" blir en sektionsrubrik över de två slidrarna istället för en slider-label.

