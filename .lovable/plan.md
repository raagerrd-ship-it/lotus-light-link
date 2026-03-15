

## Flytta rawPct till före all slider-bearbetning

**Nuläge:** `rawEnergyPctRef` fångas från `normalized` (total AGC RMS) — en helt annan signal-väg än den per-band-pipeline som genererar output. Därför matchar de aldrig, oavsett slider-inställningar.

**Lösning:** Fånga rawPct från per-band AGC-värdena (`rawBassNorm`, `rawMidHiNorm`) med jämn viktning (50/50), utan smoothing, utan dynamicDamping, utan brightness-mapping. Då visar referenslinjen signalen *innan* alla sliders, och varje slider-ändring syns som skillnad mellan linjerna.

### Ändring i MicPanel.tsx

**Rad 487** — ändra från:
```typescript
rawEnergyPctRef.current = Math.round(normalized * 100);
```
till:
```typescript
// Raw = per-band AGC output, equal weight, no smoothing/damping/brightness
const rawEnergy = rawBassNorm * 0.5 + rawMidHiNorm * 0.5;
rawEnergyPctRef.current = Math.round(rawEnergy * 100);
```

**Resultat:** I bypass-läge (bassWeight=0.5, snabb attack/release, dynamicDamping=0, min=0, max=100) blir output identisk med raw. Ändra vilken slider som helst → skillnaden syns direkt i diagrammet.

