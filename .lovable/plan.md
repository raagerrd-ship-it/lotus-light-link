

# Sonos-volym + En-punkts kalibrering + AGC-toggle + Gain-logik

## Översikt

Hämta Sonos-volymen via UPnP, använd en-punkts kalibrering med manuell finjustering, och lägg till AGC-toggle. Kalibreringsflödet: spela musik → justera gain-slider tills ljuset känns rätt → tryck "Kalibrera" → systemet sparar `(sonosVolume, manualGain)` som referenspunkt och extrapolerar gain för alla volymnivåer.

## Ändringar

### 1. `sonos-local-proxy/index.js`
- Lägg till `GetVolume` SOAP-request till `RenderingControl` (parallellt med position/transport)
- Inkludera `volume: 0–100` i `/status`-svaret

### 2. `src/hooks/useSonosNowPlaying.ts`
- Parsa `volume` från status-response
- Exponera `volume: number | null` i `SonosNowPlaying`-interfacet

### 3. `src/pages/Index.tsx`
- Nytt state: `agcEnabled` (default `true`), `manualGain` (default `5`), `calibration` (sparad i localStorage)
- Header: AGC-toggle-knapp (Activity-ikon) + Kalibrera-knapp
- Under headern (när AGC av eller kalibreringsläge): gain-slider (range 0.5–20, steg 0.5)
- Skicka `agcEnabled`, `manualGain`, `sonosVolume`, `calibration` som props till MicPanel
- Kalibrera-knappen sparar `{ volume: currentSonosVolume, gain: currentManualGain }` i localStorage

### 4. `src/components/MicPanel.tsx`
- Nya props: `agcEnabled`, `manualGain`, `sonosVolume`, `calibration`
- Gain-beräkning (ersätter rad 365–366):

```text
Om calibration finns + sonosVolume finns:
  # Exponenten ~2.5 (perceptuell volymkurva)
  volumeRatio = (calibration.volume / sonosVolume) ^ 2.5
  effectiveGain = calibration.gain * volumeRatio

Om AGC av (ingen kalibrering):
  effectiveGain = manualGain

Om AGC på (ingen kalibrering):
  effectiveGain = nuvarande AGC-logik (oförändrad)
```

- `energy = rawEnergy * Math.min(effectiveGain, 30)` (samma cap som idag)
- AGC-uppdateringen (rad 361–364) skippas helt när AGC är av eller kalibrering är aktiv

### 5. Kalibreringsflöde (UX)

```text
1. Spela musik på Sonos
2. Stäng av AGC (toggle i headern)  
3. Gain-slider dyker upp — dra tills ljuset känns bra
4. Tryck "Kalibrera" — systemet sparar (sonosVolume, manualGain)
5. Framöver extrapoleras gain automatiskt vid volymändringar
6. Slider finns kvar för manuell finjustering ovanpå kalibrering
```

### 6. Groove phase-tightening + Ambient smoothing
- Groove-zonen: `phase < 0.5` → `phase < 0.3`
- Ambient: EMA-smoothing via `smoothedAmbientRef` (`prev * 0.85 + cur * 0.15`)

### Filer att ändra
- `sonos-local-proxy/index.js` — GetVolume SOAP + response
- `src/hooks/useSonosNowPlaying.ts` — parsa volume
- `src/pages/Index.tsx` — AGC-toggle, gain-slider, kalibrera-knapp, state
- `src/components/MicPanel.tsx` — gain-logik, groove tightening, ambient smoothing

