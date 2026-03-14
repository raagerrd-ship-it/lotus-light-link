

# Konsertljusstyrning — Förbättringsplan

## Nuläge
Ljusstyrningen har bra grunder (sektioner, beat-puls, white kicks, build-ups) men allt är subtilt. Beat-pulsen ger max +15% brightness, hard transitions bara +10, build-ups +20. Det saknas dramatiska kontraster som gör att det känns som en riktig konsert.

## Förbättringar

### 1. Starkare beat-puls med sektion-skalning
Öka `pulseBoost` från `* 15` till `* 30` i drops/chorus. Drops och refränger ska ha tydligt pumpande ljus synkat med beaten.

### 2. Strobe-effekt i drops
Snabba vita blixtar (40ms on/off) under drop-sektioner istället för enbart lägre kick-tröskel. Stroboskopen triggas av beat-grid för exakt timing — varje beat ger en kort vit blixt.

### 3. Djupare dynamik mellan sektioner
Justera `SECTION_PARAMS` så att kontrasten mellan lugna och intensiva partier är mycket större:
- Intro/outro: 30% → **15%** brightness
- Verse: 70% → **50%**
- Break: 30% → **10%**
- Chorus/drop behåller 100%

Detta skapar den dramatiska skillnaden som kännetecknar konsertljus.

### 4. Blackout före drops
1-2 sekunder innan ett drop (slutet av build_up): snabb dim ner till near-zero, sedan explosion av ljus vid drop-start. Använder befintlig `getBuildUpIntensity` — när den är >0.9 (sista 10% av build-up) dimmas ljuset istället för att öka.

### 5. Färgskift vid sektionsbyten
Rotera genom paletten vid sektionsbyten (chorus→verse→chorus). Istället för att hålla samma albumfärg hela låten, cykla genom extraherade palettfärger vid varje hard transition.

### 6. Starkare hard-transition flash
Öka hard transition flash från +10 till +30 brightness, och utöka till en kort (80ms) vit blixt istället för bara brightness-boost.

## Teknisk implementation

### Filer som ändras

**`src/lib/sectionLighting.ts`**
- Djupare brightnessScale-värden för lugna sektioner
- Starkare beatPulseStrength för chorus/drop
- Ny parameter `strobeOnBeat` för drops

**`src/components/MicPanel.tsx`**
- Strobe-logik: på varje beat i drop-sektioner, trigga 40ms vit blixt
- Blackout-logik: när buildUp > 0.9, invertera — dim ner istället för upp
- Starkare pulseBoost-multiplikator (15 → 30)
- Hard transition flash: 80ms vit blixt istället för +10 brightness
- Palette rotation vid sektionsbyten

**`src/pages/Index.tsx`**
- Skicka palette till MicPanel för färgrotation

### Sammanfattning av effekten

```text
Nuvarande:    ──────────▄▄▄▄▄▄▄▄▄──────────▄▄▄▄▄▄▄▄▄──
                verse      chorus     verse      chorus

Förbättrad:   ───▂▂▂▂▂▂█████████▁▁───▂▂▂▂▂▂█████████▁▁
               intro verse  CHORUS break verse  CHORUS outro
                              ↑                    ↑
                        strobe+maxljus       strobe+maxljus
```

Dramatisk kontrast mellan sektioner, strobe i drops, blackout-moment och färgbyten = konsertupplevelse.

