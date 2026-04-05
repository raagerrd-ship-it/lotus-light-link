

## Uppdatera planen med mjukhetsmål

Lägger till en sektion **"BLE-timing & effektkvalitet"** efter rad 43 (efter Pi #1 tjänstbeskrivningar, före `---`-separatorn) med följande innehåll:

```text
### BLE-timing & effektkvalitet
- **Bekräftat baseline (webbläsare):** 40ms tickMs — stabilt
- **Mål (Pi #1 headless):** ~25–30ms tickMs (33–40 Hz)
- **Syfte:** Mjukare effekter — fler interpolationssteg per sekund ger
  glidande övergångar istället för synliga hopp. Inte snabbare blinkande.
  - 25 Hz → 25 steg/sek per fade; 40 Hz → 40 steg/sek — 60% finare upplösning
  - Befintlig smoothing/extraSmooth-logik får mer data att jobba med
- **Möjliggörs av:** ALSA (~1.5ms buffer), noble HCI-socket, ingen GC/DOM-overhead
- **Hårdvarugräns:** ELK-BLEDOM ~25ms per GATT-write
```

### Ändring
- **Fil:** `.lovable/plan.md`
- **Plats:** Ny underrubrik efter rad 43, före rad 45 (`---`)
- Inga andra filer påverkas

