# Bedömning: stabilitet OK, dynamiken är sannolikt den svaga punkten

## Vad koden faktiskt gör idag (verifierat i källan)

Ljus-kedjan i `piEngine.tickInner` är nu:

```text
shape = clamp(bands.totalRms)            // rå RMS × tvåpunkts-gain, ingen AGC
 + peakBoost om intensity > 0.90
 → tystnads-gate (tickEnergyFloor 0.01)
 → attack/release-smoothing (attack 1.0, log-release 0.45)
 + fluxBoost (transientGain 0.4)
outN = floorN + energyForm × (1 - floorN)   // floor = 25 %
pct  = round(outN × 100), flickerDeadband 0.02
```

Stabilitetssidan ser bra ut: hard-fail-pipeline med abort-räknare när mic-frame
saknas, NaN-guards, atomiska storage-skrivningar, icke-blockerande 1-slot
BLE-writer med stale-release, ACL-gate och keep-alive-recovery. Inget i den
delen pekar mot frysningar längre.

Dynamiken är den svaga punkten, av två strukturella skäl i koden ovan:

1. `shape` ÄR RMS-amplituden rakt av. RMS på loudness-normaliserad musik varierar
   litet inom en låt, så mellanregistret dominerar och 0-till-1-svinget används
   aldrig fullt ut — ljuset "andas" i ett band i stället för floor→tak.
2. `brightnessFloor = 25` äter dessutom nedersta fjärdedelen, så det svinget som
   finns komprimeras in i 25–100 %.

Hur stort svinget faktiskt är just nu är INTE mätt — det avgör hur hårt vi ska
expandera, så steg 1 nedan är en mätning, inte en gissning.

## Plan

### Steg 1 — Mät det verkliga svinget (ingen kodändring)
Logga `level`, `shape`, `energyForm`, `brightnessPct` från `/api/diagnostics`
i ~2 minuter under en typisk låt och räkna ut min / median / p95 för `level`.
Verifiering: vi vet om `level` ligger t.ex. 0.35–0.85 (komprimerat) eller redan
0.05–1.0 (då är floor/deadband problemet, inte formen).

### Steg 2 — Statisk expansionskurva på formen
Ny cal-param `shapeExpand` (default 1.0 = av, dvs. exakt dagens beteende):

```text
shape = clamp((level - inLow) / (inHigh - inLow)) ^ shapeExpand
```

med `inLow`/`inHigh` satta från mätningen i steg 1 som FASTA tal i inställningarna
(inte adaptiva). Det ger floor→tak-svep utan att införa AGC, dynamicCenter eller
profiler på ljus-tappen — de förblir borta enligt tidigare beslut. Kurvan läggs
FÖRE peakBoost och smoothingen så release fortfarande fadear jämnt.

### Steg 3 — Släpp botten fri
Sänk `brightnessFloor`-defaulten från 25 till ca 8–10 så breakdowns faktiskt går
mörka, och behåll deadband 0.02 (den blockerar bara mikrojitter).

### Steg 4 — UI
En slider "Dynamik" i Ljus-panelen som styr `shapeExpand`, plus visning av
in-låg/in-hög som två små numeriska fält (ifyllda av mätningen). `LightPreview`
visar redan `outputBrightness`, så effekten syns direkt när man drar.

### Steg 5 — Verifiering
Kör om mätningen från steg 1: `brightnessPct` ska nu nå ≤ golvet i breakdowns och
95–100 % i refränger under samma låt. Om inte, justera bara `inHigh`/`shapeExpand`.

## Teknisk detalj
- Rör bara `pi/src/piEngine.ts` (kurvan + defaults) och `src/pages/PiMobile.tsx`
  (slidern). Ingen ändring i `alsaMic.ts`-gainen eller analysatorns AGC.
- `shapeExpand = 1.0`, `inLow = 0`, `inHigh = 1` ger bit-identiskt dagens output,
  så uppgraderingen är riskfri innan man rör slidern.
