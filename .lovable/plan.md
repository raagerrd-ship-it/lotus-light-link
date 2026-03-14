

## Kedjesynkronisering — ny kalibreringsflik

### Problemet

Du har helt rätt. Hela kedjan ser ut så här:

```text
Sonos-proxy tidsstämpel
  → Sonos spelar upp ljud
    → Ljud når mikrofonen (rumsavstånd)
      → AudioContext processar (bufferstorlek)
        → Tick-worker → BLE-skrivning
          → Lampa tänds

Nuvarande bleLatencyMs täcker BARA: BLE-skrivning → lampa tänds
```

`bleLatencyMs` sparas men **används faktiskt aldrig** i ljusloopen — `getSongPositionSec()` returnerar rå Sonos-position utan kompensation. Så även det vi kalibrerat appliceras inte.

Det saknas:
1. **Sonos-proxy → ljud ur högtalaren** (Sonos intern buffring, ~50-200ms)
2. **Högtalare → mikrofon** (ljud genom rummet, ~3-15ms beroende på avstånd)
3. **Mic → processad RMS** (AudioContext-buffert, ~5-25ms)
4. **BLE-transport** (redan mätt men ej applicerad)

### Plan

**Steg 1: Applicera `bleLatencyMs` i ljusloopen (buggfix)**

I `getSongPositionSec()` i MicPanel.tsx, addera `bleLatencyMs` som look-ahead så att kurvan läses framåt i tiden för att kompensera BLE-fördröjningen:

```
const posSec = (pos.positionMs + elapsed) / 1000 + cal.bleLatencyMs / 1000;
```

**Steg 2: Ny kalibreringsflik "Kedja" (Chain sync)**

Mäter hela kedjan Sonos → lampa genom att:
1. Systemet spelar en kort tyst paus följt av en skarp "klick" via Sonos (eller användaren klappar i händerna nära mic + tittar på lampan)
2. Enklare approach: **Tappa i takt med lampan** (som befintlig tap-sync) men nu medan en inspelad låt spelas. Skillnaden mellan tap-timing och kurva-position ger hela kedjans fördröjning.

Sparas som `chainLatencyMs` i `LightCalibration`. Look-ahead i curve-driven mode använder detta istället för bara `bleLatencyMs`.

**Steg 3: Uppdatera `LightCalibration`**

- Nytt fält: `chainLatencyMs: number` (total fördröjning hela kedjan)
- Default: 0
- DB-migration behövs ej (calibration sparas som JSON)

### Ändringar

| Fil | Ändring |
|-----|---------|
| `src/lib/lightCalibration.ts` | Lägg till `chainLatencyMs` i interface + default |
| `src/components/MicPanel.tsx` | `getSongPositionSec()` adderar `chainLatencyMs` som look-ahead i curve-mode, `bleLatencyMs` i mic-mode |
| `src/pages/Calibrate.tsx` | Ny tab `'chain'` med `ChainSyncTab` — tap-sync mot spelande kurva, mäter total offset, sparar `chainLatencyMs` |

### Kedja-kalibreringens flöde

1. Spela en inspelad låt på Sonos
2. Systemet driver lampan från kurvan (som vanligt)
3. Användaren tappar på skärmen i takt med **lampans blixtar/beats**
4. Systemet jämför tap-tidpunkterna med kurvans kända beat-positioner
5. Differensen = total kedjelatens
6. Sparas och appliceras som look-ahead

