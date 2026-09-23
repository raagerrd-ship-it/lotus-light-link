# Modulerna och deras regler

*Ägarens krav 2026-09-23: "alla moduler har tydliga regler för vad de får göra och inte — då kan vi ha exakt samma moduler på vissa
ställen, för två olika input och två olika output." Den här filen ligger identiskt i `lotus-light-link/ARKITEKTUR.md` och
`dmx-control/pi-dmx/ARKITEKTUR.md`. Ändras den, ändras den på båda ställena.*

Kedjan är densamma i båda systemen:

```
INPUT  →  ANALYS (snabb | långsam)  →  DIRIGENT  →  OUTPUT
                     └──── HEART-BEAT / ENERGI ────┘   (sidoberäkning: två globala tal)
```

| Modul | lotus (BLE-remsa) | pi-dmx (DMX-rigg) | Kod |
|---|---|---|---|
| INPUT | ALSA/mic | aux/mic (codec) | `pi/src/alsaMic.ts` · `src/audio.ts` |
| ANALYS | **identisk** | **identisk** | `audio-analyser/` (kopieras fil för fil) |
| DIRIGENT | en effekt ("uniform") | 43 effekter + val | `piEngine` (implicit) · `src/effects.ts` + `effects/*.ts` |
| HEART-BEAT/ENERGI | **identisk** | **identisk** | `heartbeat/heartbeat.ts` + `contract.ts` |
| OUTPUT | 1 lampa, BLE-paket på radions raster | N fixturer, DMX-ram 40 Hz | `piEngine` steg 6/7 + `ble-driver/` · `postprocess.ts` + `dmx.ts` |

Regeln för "identisk": samma fil, samma innehåll, kopierad — aldrig lokalt lappad. Bevis: `splitProof.mjs` (analys), `heartbeatProof.mjs`
(heart-beat). En förbättring som bevisas i det ena systemet flyttas till det andra som fil, inte som idé.

---

## INPUT
**Får:** läsa hårdvaran, leverera 375 Hz-hop (128 sampel @ 48 kHz) med en monoton ljudklocka; sköta gain så att analysen får en
signal i rätt storleksordning (lärd gain per volym i lotus).
**Får inte:** tolka musiken (inget onset, ingen nivå-till-ljus, ingen bandviktning som betyder något för ljuset). Ljusets nivåkanal tas
ur ANALYS, inte ur INPUT — spektral viktning i INPUT var rotorsaken till lotus nivå-r 0,28 (agent L 09-23).
**Ut:** `Float32Array(128)` per hop + `audioClockMs`.

## ANALYS
**Får:** allt som handlar om att förstå ljudet: FFT, band, onset, kick, nivå/energi, drop, tempo, gridfas, sektion, minne inom låten,
förutsägelse. Två trådar: **snabb** (per hop, latenskritisk: FFT, band, onset, kick, nivå, drop) och **långsam** (worker på egen kärna:
tempo, gridfas, sektion, upprepning, förutsägelse), sammanbundna av `split.ts` (SAB-ring, kommandon som flaggor i recordet).
**Får inte:** veta något om lampor, effekter, kalibrering eller hårdvara; ändra beteende beroende på vilket system som kör (bara env-flaggor
som är dokumenterade i filen); lära mellan spelningar (låtminnet är avstängt med avsikt — minnet gäller INOM spelningen).
**Lär sig:** bara på PC:n mot facit (korpus, bänk, agenter); det som vinner på test mot båda faciten deployas som kod.
**Ut:** `Frame` — level/energy/flux/kick, bpm + beatAnchorMs/beatPhaseMs, dropCount/buildUp/inRiser, section + sectionTier/sectionBars/
prevSection, expectHighInMs, levelVsHighDb, repeatSim, profile (punch/bass/bright/beat/bassline), spec/onset/drum.

## DIRIGENT
**Får:** välja VAD som visas: vilken effekt (DMX) och när det byts; läsa hela `Frame` (sektion, tier, förutsägelse, basgång, karaktär);
deklarera per effekt vilka globala modulatorer som ska gälla (`modulate: { energy, pulse }`) och skriva över effektens standard
(t.ex. puls av vid låg tillit, energi på i lugnt parti).
**Får inte:** sätta absoluta ljusnivåer, räkna egna nivå- eller pulskurvor, läsa kalibreringen, känna till fixturernas golv/max eller
protokoll. Effekternas utdata är AVSIKT: färg + relativ intensitet 0–1 per lampa.
**Ut:** `Intent { lamps: [{ rgb, level }], modulate }`.
**Mått:** effektmix (`tools/effectMix.mjs`: hur många effekter, hur jämnt, uppehåll), likhet mellan effekter (`effectSimilarity.mjs`).

## HEART-BEAT / ENERGI
**Får:** räkna två GLOBALA tal per tick ur ANALYS + kalibreringens rattar: `ceiling` (energitaket: nivå × sektionsreferens × uppbyggnad,
drop lyfter mot 1) och `pulse` + `pulseDepth` (pulskurvan ur taktklockan, prediktiv mot visningsögonblicket; djup = tillit × sektionens
pulsvikt × kalibrerat djup).
**Får inte:** veta något om lampor, effekter, färger eller protokoll; röra avsikten; känna till hur många lampor som finns.
**Ut:** `Envelope { ceiling, pulse, pulseDepth }`.
**Mått:** taket mot ljudet (`ceilR` i facit-tjänsten), pulsen mot slagen (on-beat-andel).

## OUTPUT
**Får:** komponera: `ljus_i = kal_i( level_i × (energy ? ceiling : 1) × (pulse ? 1 − d + d·pulse : 1) )`; tystnadsgrinden (ingen musik →
mörkt, gäller ALLA effekter även de som skippar energin); kalibrering per lampa (golv/max, gamma, tändtröskel LAMP_MIN); ballistik som
hör till lampan (attack/release som kompenserar lampans egen tröghet); kodning och tidsättning mot hårdvaran (BLE-paket i fas med
radions raster; DMX-universum 40 Hz).
**Får inte:** välja effekt, tolka musiken, räkna puls eller energi; ändra betydelsen av ett sparat kalibreringsfält.
**Mått:** ljud→ljus-latens (klapp + 240 fps-video: 30 ms, accepterad, ej kompenserad), stigtid, paketluckor.

---

## Regler som gäller alla moduler
1. **Kontrakt i typer, inte i prosa.** `heartbeat/contract.ts` (Intent, Envelope, ModulateFlags, composeLamp) och `Frame` i
   `audio-analyser/analyser.ts` är gränssnitten. En modul importerar bara sina grannars typer.
2. **Ingen modul vet vilket system den kör i.** Skillnader uttrycks som konfiguration (antal lampor, kalibrering, env-flaggor), aldrig som
   `if (lotus)`.
3. **Bevis före beteendeändring.** Utbrytning/flytt = bit-identiskt (proof-skript). Beteendeändring = bänk mot facit (analys), mixmått
   (dirigent), eller ögat i ladan/källaren (heart-beat, output) — och alltid opt-in-flagga först så gamla vägen finns att jämföra med.
4. **Latenskritiskt stannar i den snabba tråden**: allt som ska påverka ljuset inom ett paket (kick, nivå, drop, puls, output). Allt som
   får ta sekunder (tempo, sektion, minne, förutsägelse) går i workern.
5. **Hemligheter** (lösenord, molnnycklar) finns bara i miljön, aldrig i kod, commits eller rapporter.
