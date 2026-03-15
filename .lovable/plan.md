

## Problem
Kalibreringssidan (`/calibrate`) kör en **separat MicPanel-instans** med hårdkodade props (`currentColor=[255,180,80]`, ingen BPM/volym/energy). Ljusbeteendet under kalibrering matchar inte normalläge. Dessutom saknas sliders för flera kalibreringsvärden (gamma R/G/B, offset R/G/B, mättnad).

## Lösning
Ta bort den separata kalibreringssidan. Bygg istället ett **mixerbord-overlay** direkt på Index-sidan som justerar den redan körande MicPanel-instansen i realtid.

## Layout — Mixerbord

```text
┌─────────────────────────────────────┐
│  [Intensitetsdiagram — full bredd]  │  ← Befintligt chart från MicPanel
├─────────────────────────────────────┤
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐    │
│  │ + │ │ + │ │ + │ │ + │ │ + │ …  │  ← Plus-knappar
│  ├───┤ ├───┤ ├───┤ ├───┤ ├───┤    │
│  │ ▓ │ │ ▓ │ │ ▓ │ │ ▓ │ │ ▓ │    │  ← Vertikala sliders
│  │ ▓ │ │ ▓ │ │ ▓ │ │ ▓ │ │ ▓ │    │
│  ├───┤ ├───┤ ├───┤ ├───┤ ├───┤    │
│  │ − │ │ − │ │ − │ │ − │ │ − │    │  ← Minus-knappar
│  └───┘ └───┘ └───┘ └───┘ └───┘    │
│  Min  Max  Atk  Rel  Dyn  …       │  ← Korta labels
│  3%  100%  30%  25‰  -2.0         │  ← Aktuellt värde
├─────────────────────────────────────┤
│  [Förklaringsruta: vald slider]     │  ← Tooltip/beskrivning
├─────────────────────────────────────┤
│  [BLE-hastighetstest] [Historik]    │  ← Sekundära sektioner (collapsed)
└─────────────────────────────────────┘
```

Horisontellt scrollbar rad med alla sliders — mixerbord-stil. Tryck på en slider visar förklaring i rutan under.

## Alla kalibreringsvärden med sliders

| Grupp | Slider | Min | Max | Steg | Enhet |
|-------|--------|-----|-----|------|-------|
| Ljus | Min ljus | 0 | 30 | 1 | % |
| Ljus | Max ljus | 30 | 100 | 1 | % |
| Dynamik | Attack | 0.05 | 0.9 | 0.01 | α |
| Dynamik | Release | 0.005 | 0.3 | 0.005 | α |
| Dynamik | Dynamik | -2.0 | 3.0 | 0.1 | × |
| Kick | Tröskel | 50 | 100 | 1 | % |
| Kick | Tid | 20 | 200 | 5 | ms |
| Färg | Gamma R | 0.5 | 2.5 | 0.05 | |
| Färg | Gamma G | 0.5 | 2.5 | 0.05 | |
| Färg | Gamma B | 0.5 | 2.5 | 0.05 | |
| Färg | Offset R | -30 | 30 | 1 | |
| Färg | Offset G | -30 | 30 | 1 | |
| Färg | Offset B | -30 | 30 | 1 | |
| Färg | Mättnad | 0.5 | 2.0 | 0.05 | × |

## Ändringar

### 1. Ny komponent: `src/components/CalibrationOverlay.tsx`
- Slide-up panel (80vh höjd) med backdrop-blur
- Intensitetsdiagrammet syns bakom (MicPanel kör som vanligt)
- Horisontellt scrollbar slider-rad i mixerbord-layout:
  - Varje slider: vertikal `<input type="range" orient="vertical">` (eller CSS-roterad)
  - `+` knapp ovanför (ökar med ett steg)
  - `−` knapp under (minskar med ett steg)
  - Kort label + aktuellt värde under
- Tryck/fokus på en slider → förklaringstext visas i ruta nedanför
- Collapsible sektioner för BLE-hastighetstest och Historik
- Sparar via `saveCalibration()` → localStorage → MicPanel plockar upp direkt

### 2. `src/pages/Index.tsx`
- Settings-knappen → `setShowCalibration(true)` istället för `navigate('/calibrate')`
- Rendera `<CalibrationOverlay>` som overlay ovanpå allt när aktiv
- Skicka `cal` state + `update` callback

### 3. `src/pages/Calibrate.tsx`
- Behåll som redirect till `/?cal=1` eller ta bort helt
- Flytta `BleSpeedTab`, `CalibrationHistory`, `CurrentCalibrationPanel` till `CalibrationOverlay`

### 4. `src/App.tsx`
- Ta bort `/calibrate` route (eller gör redirect)

## Resultat
- **En enda MicPanel-instans** — kalibrering sker live mot den riktiga ljusmotorn
- **Alla 14 kalibreringsvärden** har egna sliders med finjusteringsknappar
- **Mixerbord-layout** — kompakt, snabb att justera flera parametrar

