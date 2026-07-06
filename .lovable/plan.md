## Mål
Ha så få reglage som möjligt i UI:t. Behåll bara **4 justerbara sliders**; lås allt annat till dina nuvarande, intrimmade värden.

## Reglage som blir kvar (justerbara)
Alla i den befintliga sektionen ovanför status-rutan (ingen profilväxlare, ingen "Avancerat"):

1. **Softness (mjukhet)** — `softness`, 0–100, default 71
2. **Beat-källa (lågpass)** — `beatCutoffHz`, 60–2000 Hz, default 150 *(finns redan)*
3. **Min ljusstyrka** — `brightnessFloor`, 0–100 %, default 25
4. **Dynamik** — `dynamicDamping`, −2…2×, default 0.4

## Låsta värden (från dina skärmbilder — inga reglage)
Bakas in som fasta defaults i `Normal`-profilen:
- Punch (`attack`) = 100
- Bas↔Diskant (`bassWeight`) = 0.95
- Stabilitet (`flickerDeadband`) = 0.01
- Onset-känslighet = 0 → `onsetThreshold` 4.0, `onsetRefractoryMs` 300
- Tystnadströskel = 0.025 → `tickEnergyFloor` & `onsetEnergyFloor` 0.025
- Transient boost (`transientGain`) = 1.1
- Vita peaks (`punchWhiteThreshold`) = 100 (av)
- Perceptuell kurva (`perceptualGamma`) = 1.2
- Drop-flash på, `dropSensitivity` 0.64, `dropFlashMs` 220

## Ändringar (endast `src/pages/PiMobile.tsx`)
1. Uppdatera `PRESET_CALS.Normal` med värdena ovan (så en ny/tom Pi startar rätt).
2. I den befintliga "Beat-källa"-sektionen: lägg till tre enkla range-sliders (samma stil som lågpass-slidern) för Softness, Min ljusstyrka och Dynamik, kopplade till `setCal({ ...cal, ... })`.
3. Byt sektionsrubriken till t.ex. **"Ljusinställningar"** så den täcker alla fyra.

Ingen ändring i motorn/API behövs — alla fält sparas/laddas redan via `/api/profiles`.

## Att notera
Profil-panelen du ser i den **publicerade** appen finns inte i senaste koden (togs bort tidigare). Detta bygger en avskalad ersättning. När du publicerar ersätts den gamla stora panelen med dessa fyra reglage. Övriga låsta värden gäller den aktiva profilen `Normal`; profilväxlaren återkommer inte.

Vill du att jag kör detta?