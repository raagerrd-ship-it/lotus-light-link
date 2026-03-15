

# Färgkälla-väljare: Proxy eller Manuell färg

## Översikt
Lägg till en enkel väljare i headern så användaren kan byta mellan **Sonos proxy** (nuvarande beteende) och **Manuell färg** (color picker).

## Ändringar

| Fil | Vad |
|-----|-----|
| `src/pages/Index.tsx` | Lägg till state `colorSource: 'proxy' | 'manual'` (från localStorage). Visa en liten toggle/popover vid headern. I proxy-läge: behåll nuvarande `extractPalette`-logik. I manuell: skippa palette-extraction, visa en color picker. Spara `manualColor` i localStorage. |
| `src/lib/ui/calibrationCloud.ts` | Synka `colorSource` och `manualColor` till molnet (lägg till i settings-objektet) |

## Detaljer

**State:**
- `colorSource` sparas i `localStorage('colorSource')`, default `'proxy'`
- `manualColor` sparas i `localStorage('manualColor')`, default `[255, 80, 0]`

**UI (i headern, ny knapp bredvid ⚙):**
- Klick togglar mellan proxy 🔌 och manuell 🎨
- I manuellt läge visas en enkel HSL color wheel / native `<input type="color">` i en popover
- Vald färg appliceras direkt som `currentColor`

**Logik i Index.tsx:**
- `useEffect` för album art: kör bara om `colorSource === 'proxy'`
- Om `colorSource === 'manual'`: sätt `currentColor` från `manualColor` vid mount och vid ändring
- Vid byte från manual → proxy: trigga ny palette-extraction om det finns en aktiv `albumArtUrl`

