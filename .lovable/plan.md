

# Auto-kalibrering utan Spotify API

Eftersom Spotify Developer-appen inte går att skapa just nu, kan vi istället använda den **redan existerande AI-analysen** (Gemini via `song-analysis` edge function) och be om en **detaljerad energikurva** — en loudness-uppskattning var 0.5 sekund genom hela låten.

Det är inte lika exakt som Spotify Audio Analysis, men tillräckligt bra för cross-correlation av latens, gain och dynamik-parametrar. Och det kräver **inga nya API-nycklar**.

## Ändringar

### 1. Databasändring
- Lägg till `energy_curve jsonb` (nullable) i `song_analysis`-tabellen

### 2. Utöka `song-analysis` edge function
- Utöka AI-prompten: be om `energyCurve` — array med `{t, e}` objekt var 0.5s (t = sekund, e = energi 0.0-1.0)
- Returnera och cacha `energy_curve` i databasen
- Separera anropet om kurvan saknas i cache (kan kräva längre AI-svar)

### 3. Ny fil `src/lib/autoCalibrate.ts`
- **Cross-correlation**: skjuter mic-RMS ±500ms mot energikurvan, hittar bästa latens-offset
- **Gain-fit**: median-ratio mic-RMS / förväntad energi → gain-faktor
- **Dynamik-fit**: testar rutnät av attack/release/damping, kör EMA-simulering, väljer lägst MSE
- Exporterar `runAutoCalibration(energyCurve, micSamples) → { latencyMs, gain, attack, release, damping }`

### 4. Ny tab "Auto" i `Calibrate.tsx`
- Visar aktuell låt från Sonos (auto-detect via `useSonosNowPlaying`)
- Knapp "Hämta energikurva" → anropar edge function
- Knapp "Starta kalibrering" → lyssnar via mikrofon i ~30 sek, samlar RMS + tidstämplar
- Realtidsgraf: AI-kurva (grå) vs mic-kurva (grön)
- Resultat: beräknad latens, gain, dynamik-parametrar med diff mot nuvarande
- "Applicera"-knapp som sparar till `lightCalibration`

### 5. Uppdatera `lightCalibration.ts`
- Lägg till `latencyOffsetMs` i `LightCalibration`-typen
- Använd offset i MicPanel för att tidsförskjuta BLE-kommandon

## Begränsningar
- AI-energikurvan är en uppskattning, inte exakt mätdata — men tillräcklig för kalibrering av latens och dynamik
- Kan förbättras senare med Spotify-data när appen går att skapa

