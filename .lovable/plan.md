

# Pi Mobile UI — Layoutförhandsvisning på `/pi-mobile`

Bygger en fullständig mockup av Pi-mobilgränssnittet som en route i Lovable-appen. Använder simulerad data (ingen riktig Pi-anslutning behövs) så du kan se och finslipa layouten direkt i preview.

## Vad som byggs

### Startskärm
- Statusrad: anslutningsindikator (simulerad grön) + kugghjulsikon
- Kompakt info: "BLE: 2 enheter" / "Sonos: ▶ Låtnamn"
- 2×2 preset-grid (Lugn, Normal, Party, Custom) — aktiv markerad med accent
- Idle-färg: RGB-sliders + förhandsvisningsruta

### Inställningsvy (via ⚙️)
- Tillbaka-pil
- Kalibrerings-sliders: attackAlpha, releaseAlpha, dynamicDamping, bassWeight, brightnessFloor, smoothing
- Tick rate slider (20–200 ms)
- Sonos Gateway URL-input
- Varje slider visar label + aktuellt värde

### Design
- Mörkt tema, samma `bg-background` som resten av appen
- Optimerat för mobilbredd (single column, 48px+ touch targets)
- Inga externa beroenden — Tailwind + native inputs

## Filer

| Fil | Ändring |
|-----|---------|
| `src/pages/PiMobile.tsx` | **Ny** — Komplett mockup med simulerad data, startskärm + inställningsvy |
| `src/App.tsx` | Ny route: `/pi-mobile` |

All data är hårdkodad/simulerad — ingen fetch till Pi. När layouten är godkänd konverterar vi till `pi/src/public/index.html` med riktiga API-anrop.

