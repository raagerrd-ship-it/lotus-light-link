# "Synka gain"-knapp + verifiering

## Varför finns det två ställen?

Gain-punkterna lever i två lager, med olika syfte:

- **Live-lagret** (`gain-cal-points` i storage, läses av mic-modulen): det som motorn faktiskt använder just nu, och det som återläses vid omstart innan profilerna hunnit appliceras.
- **Profil-lagret** (`profiles.json` → `profiles[aktiv].gainCalibration`): per-profil-värde, så att t.ex. TV-profilen kan ha annan gain än Normal. Vid profilbyte skrivs profilens punkter ner i live-lagret.

Båda skrivs redan i samma anrop (`PUT /api/gain-calibration` skriver live + aktiv profil, och profilbyte skriver profil → live). De kan dock glida isär i praktiken: om profiler byts/redigeras utanför gain-flödet, om en gammal `profiles.json` saknar `gainCalibration`, eller om en av skrivningarna felar tyst (`catch {}`). Därför en explicit synk- och verifieringsknapp.

## Vad som byggs

### Backend (`pi/src/configServer.ts`)
Ny endpoint `POST /api/gain-calibration/sync`:
1. Läs de auktoritativa punkterna från live-mic (`mic.getGainCalPoints()`).
2. Skriv dem till live-storage (`gain-cal-points`) och till aktiv profils `gainCalibration` i `profiles.json`.
3. Läs tillbaka båda lagren och jämför punkt för punkt (vol + gain).
4. Svara med `{ ok, match, live, profile, activePreset }` så UI kan visa resultatet.

Ny endpoint `GET /api/gain-calibration/sync` (samma jämförelse utan att skriva) så UI kan visa om lagren är i synk redan innan man trycker.

### UI (`src/pages/PiMobile.tsx`)
- Liten knapp "Synka gain" i gain-/kalibreringssektionen.
- Vid klick: anropa sync-endpointen, visa kort status: "I synk" (grön) med punktvärdena, eller "Fel" (röd) om lagren fortfarande skiljer sig eller anropet misslyckas.
- Efter lyckad synk: läs om punkterna så slidrarna visar samma värden som backend.
- Passiv indikator: om `GET`-kontrollen (körs vid initial load) rapporterar mismatch, markera knappen som "Osynkad".

## Teknisk detalj
Jämförelsen görs med exakt likhet på `vol` och `gain` (avrundat till 2 decimaler) och behandlar `null`-punkter som matchande bara om båda sidor är `null`. Live-mic är source-of-truth i sync-riktningen, eftersom det är den kurva motorn faktiskt kör. Ingen ändring av gain-matten, AGC:n eller ljus-kedjan.
