

## Research: Professionell ljusstyrning från förberäknad data

Jag har undersökt hur professionella ljussystem (DMX, WLED Sound Reactive, konsertbelysning) hanterar audio-till-ljus-mappning. Här är de viktigaste insikterna och en plan för förbättringar.

---

### Vad professionella system gör som vi saknar

**1. CIE 1931 Perceptuell ljuskurva (istället för smoothstep)**
Den nuvarande `lightingGamma` använder `smoothstep` — men det är inte perceptuellt korrekt. Mänskliga ögat uppfattar ljusstyrka logaritmiskt. CIE 1931-formeln ger jämnare upplevda steg:

```text
L* < 8:   Y = L* / 903.3
L* >= 8:  Y = ((L* + 16) / 116) ^ 3
```

Detta innebär att låga brightness-värden (5-20%) borde spridas ut mer och höga värden komprimeras. Just nu hoppar ljuset för snabbt genom lågintensitetsområdet.

**2. Separata envelope followers per frekvensband**
Professionella system (WLED SR, DMX-konsoler) kör separata attack/release-envelopes för bas, mid och diskant — inte bara en enda smoothed RMS. Bas driver "kroppen" (brightness), mid driver "färgmodulation", och diskant driver "glitter/strobes".

**3. Squelch/noise gate**
Tyst passage = mörkt. Inte "min brightness". Professionella system har en tydlig tröskel under vilken ljuset är helt släckt eller på en fast ambient-nivå — ingen reaktion alls. Det förhindrar att bakgrundsljud/tystnad skapar nervöst flimmer.

**4. Beatens form: ADSR, inte bara exponentiell decay**
Konsolljus använder ADSR-envelopes per beat:
- **Attack**: 0-15ms (instant flash)
- **Decay**: 30-80ms (snabb drop)
- **Sustain**: 40-60% av peak (håll kvar ljus)
- **Release**: 100-200ms (mjuk fade)

Just nu: `exp(-phase * 6)` — det saknar sustain, vilket gör att beats känns "spetsiga" och korta.

**5. Kontrast via "dipping" före beats**
Professionella LD:er sänker ljuset strax INNAN en beat träffar, så att kontrasten blir starkare. Det kallas "anticipation dip" — 20-50ms av sänkt brightness innan beat-puls.

---

### Plan: Förbättra `computeBrightnessCurve` i process-songs

**Steg 1: CIE 1931 perceptuell kurva**
Ersätt `lightingGamma(smoothstep)` med CIE 1931 inverse — omvandla linjär brightness till perceptuellt korrekt LED-PWM-värde. Detta gör att alla övergångar ser jämnare ut för ögat.

**Steg 2: Separata band-envelopes**
Kör tre EMA-followers (bass, mid, hi) istället för en blandad signal. Bass driver 70% av brightness, mid 20%, hi 10%. Varje band har optimerade attack/release-tider:
- Bas: attack 15ms, release 80ms  
- Mid: attack 10ms, release 50ms
- Hi: attack 5ms, release 30ms

**Steg 3: ADSR beat-envelope**
Ersätt `exp(-phase * 6)` med en riktig ADSR-kurva per beat. Attack 10ms, decay 60ms till 50% sustain, release 150ms. Downbeats (beat 1) får 100% amplitud, andra beats 60-80%.

**Steg 4: Anticipation dip**
30ms innan varje beat, sänk brightness med 15-25%. Detta skapar kontrast som gör att pulsen "poppar".

**Steg 5: Noise gate / squelch**
Under P10-energi → fast floor (2-3%), ingen reaktivitet. Förhindrar flimmer i tysta passager.

**Steg 6: Sektionsmood-förbättringar**
- Breaks: 0-5% brightness med långsam "breathing" (0.5 Hz sinus)
- Build-ups: exponentiell ramp med 16:e-dels puls-acceleration
- Drop-ingång: 0ms attack, full brightness instant

---

### Tekniska detaljer

Alla ändringar sker i `supabase/functions/process-songs/index.ts`, specifikt i `computeBrightnessCurve`-funktionen. Inga ändringar behövs i klienten — den läser bara den färdiga `brightness_curve` via `interpolateBrightness`.

Befintliga inspelade låtar behöver bakas om (deras `brightness_curve` sätts till null så att nästa process-songs-körning genererar nya kurvor).

