

## Visa neutralläget på varje fader

**Problemet:** Bypass-värdena (noll-påverkan) ligger på olika positioner beroende på slider — vissa längst ner, vissa längst upp, vissa i mitten. Det finns ingen visuell markering av var "noll" är.

**Lösning:** Lägg till en visuell referensmarkör (tunn horisontell linje) på varje fader som visar bypass-positionen. Slidern fylls från denna referenslinje istället för från botten, så man ser avvikelsen från neutralläget.

### Vad som ändras

**CalibrationOverlay.tsx — MixerFader:**
- Definiera en `BYPASS_VALUES`-map med neutralvärdet för varje slider-key (samma värden som `bypassAll` redan sätter).
- Beräkna bypass-positionen i procent på varje fader.
- Rita en tunn streckad horisontell linje vid bypass-positionen (t.ex. 1px vit/grå streckad).
- Fyll färgen från bypass-linjen till nuvarande position istället för från botten — uppåt om värdet är över neutral, nedåt om under.

### Visuellt resultat

```text
  Fader med neutral i botten    Fader med neutral i mitten
  ┌───┐                         ┌───┐
  │   │                         │   │
  │   │                         │   │
  │ █ │ ← thumb                 │ █ │ ← thumb
  │▓▓▓│ ← fill up from ref     │▓▓▓│ ← fill up from ref
  │───│ ← bypass ref (bottom)   │───│ ← bypass ref (middle)
  │   │                         │   │
  └───┘                         └───┘
```

Inga ändringar i slider-ranges eller semantik — bara en tydlig visuell referens så man ser exakt hur långt från neutralläget man är.

