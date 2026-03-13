

# Kalibreringssida — komplett uppsättning

## Översikt
En dedikerad `/calibrate`-sida med flera flikar för att finjustera alla aspekter av ljusupplevelsen. Kalibreringsvärden sparas i localStorage och appliceras automatiskt i analysloopen.

## Kalibreringsparametrar

### 1. Färgkalibrering (Color)
- **Per-kanal gamma** (0.5–2.5) — kompenserar ojämn LED-ljusstyrka mellan R/G/B
- **Per-kanal offset** (-30 till +30) — finjustera nyanser
- **Mättnadsboost** (0.5–2.0) — BLEDOM-strips har ofta bleka färger, detta boostar mättnaden innan sändning
- Testfärgsväljare (Röd, Grön, Blå, Vit, Custom) med live BLE-preview

### 2. Ljusstyrka & Dynamik (Brightness)
- **Min-ljusstyrka** (0–30%) — lägsta nivå vid tystnad (nu hårdkodat 6%)
- **Max-ljusstyrka** (30–100%) — tak för peak
- **Attack-alpha** (0.1–0.9) — hur snabbt ljuset reagerar uppåt (nu 0.5)
- **Release-alpha** (0.02–0.2) — hur snabbt ljuset tonar ner (nu 0.08)
- **Dynamisk dämpning** (1.0–3.0) — power-kurva som komprimerar dynamiken (redan finns som slider men flytta hit)

### 3. Beat & Timing (Rhythm)
- **Punch-white tröskel** (60–95%) — vid vilken ljusstyrka punch-white triggas (nu 85%)
- **Fade-back duration** (100–800ms) — hur lång tid punch-white tar att tona ut (nu 320ms min)
- **BLE-latenskompensation** (0–150ms) — förfiring för att kompensera BLE-fördröjning (nu 50ms)
- **Groove-fas gating** (0.1–0.5) — hur stor del av beat-cykeln groove-zonen är aktiv (nu 0.3)

### 4. Ambient (Atmosphere)  
- **Ambient-vikt** (sub/bas/mid fördelning) — hur mycket varje frekvensband bidrar till bakgrundsglöd
- **Ambient EMA** (0.7–0.98) — hur trög ambientljuset är (nu 0.85)
- **Tystnad fade-tid** (500–5000ms) — hur snabbt ljuset tonar ner vid paus (nu 1500ms)

## Teknisk plan

### Nya filer
1. **`src/lib/lightCalibration.ts`** — Lagring/läsning av alla kalibreringsvärden i localStorage med defaults. Exporterar `getCalibration()`, `saveCalibration()`, `applyColorCalibration(r,g,b)`.

2. **`src/pages/Calibrate.tsx`** — Sida med flikar (Färg | Dynamik | Timing | Ambient). Varje flik har sliders med live-preview. Kräver BLE-anslutning för live-test.

### Ändringar
3. **`src/lib/bledom.ts`** — `sendColor()` applicerar `applyColorCalibration()` automatiskt.

4. **`src/components/MicPanel.tsx`** — Läser kalibreringsvärden från `getCalibration()` vid start och använder dem istället för hårdkodade konstanter (min-brightness, attack/release alpha, punch-threshold, fade-duration, BLE-latens, ambient EMA, silence fade).

5. **`src/App.tsx`** — Ny route `/calibrate`.

6. **`src/pages/Index.tsx`** — Länk till `/calibrate` i headern (kugghjulsikon).

### UX-flöde
- Varje slider uppdaterar BLE i realtid (throttlat 50ms)
- "Återställ"-knapp per flik för fabriksinställningar
- Alla värden sparas direkt i localStorage vid ändring
- Färgfliken visar en stor färgruta + skickar den till BLE medan du justerar

