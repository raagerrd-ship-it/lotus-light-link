# Bättre beat/drop-detektion på Pi Zero 2W — kick-only grund + drop-flash

## Kapacitetssvar först
Pi Zero 2W (quad A53) klarar 100 Hz-analysen med stor marginal. Den tunga delen — 1024-punkts FFT @ 100 Hz — körs **redan** idag (`alsaMic.ts:162`), och onset + dynamicCenter räknas redan @ 100 Hz (`piEngine.ts:1027`). Det vi lägger till nedan är några extra EMA:er och en bas-bands-flux per frame — försumbar CPU (<<1 %). Vi behöver alltså INTE höja någon takt; vi använder strömmen vi redan har bättre.

## Mål (från dina svar)
- **Grund:** mjuk, driven av **bara bas** (kick/sub), diskant ignoreras i grundnivån.
- **Beat:** pulsen triggas av **bara kick/bastrumma**, inte hi-hats/snare.
- **Drop:** egen detektor → **stor vit punch/flash**, sen tillbaka till grund.

## Ändringar

### 1. Bas-bands-flux (kick-only beat-källa) — `alsaMic.ts`
Idag summeras spectral flux över hela spektrumet (alla 4 segment), så hi-hats och cymbaler triggar onset lika mycket som kicken. Lägg till en separat `bassFlux` som bara summerar flux från sub+bas-bins (segment 1+2, < 150 Hz). Lägg `bassFlux` på `BandResult` och skicka den till `onFluxReady` vid sidan av (eller i stället för) dagens full-spektrum-flux. Full `flux` behålls för bakåtkompat.

### 2. Onset på bas-flux — `piEngine.ts processOnset`
Mata `processOnset` med `bassFlux` i stället för full-spektrum-flux. Behåll alla befintliga skydd (median×PROMINENCE, ABS_FLUX_FLOOR, refractory, dynamicCenter-suppression). Eftersom bas-flux har annan magnitud justeras `ABS_FLUX_FLOOR` för bas-bandet (lägre absolut energi i 3 bas-bins). Resultat: pulsen sitter på 4-on-the-floor-kicken, inte på hi-hats.

### 3. Drop-detektor (ny, lång tidshorisont) — `piEngine.ts` i `onFluxReady`
Drops är en struktur över sekunder, inte 70 ms. Spåra på 100 Hz-strömmen av **bas-energi**:
- `bassFast` = EMA ~150 ms (aktuell bas-nivå)
- `bassSlow` = EMA ~2.5 s (baslinje)
- `breakdownTimer` = hur länge `bassFast` legat lågt (breakdown/build-up)

Trigga **drop** när: ett tydligt lugnt/nedbrutet parti (`bassFast` < andel av `bassSlow` under ≥X ms) följs av ett plötsligt stort hopp (`bassFast` ≥ faktor × baslinje OCH absolut energi hög). Refractory ~4 s så ett parti bara triggar en gång.

### 4. Drop → stor vit punch — `piEngine.ts`
Vid drop: sätt en `dropFlashUntil`-tidsstämpel. Medan den är aktiv (~150–300 ms) overridas output i `tickInner` till full vit punch (pct=100, RGB 255/255/255 — samma path som `punchWhiteThreshold`), sen decay tillbaka till grund. Express-write skickas direkt vid drop (samma sub-frame BLE-path som onset) så blixten sitter i takt. Respekterar `canWriteNow()`-pre-gaten.

### 5. Grund på bara bas
Grundnivån styrs redan av `energyNorm = bassNorm*bassWeight + midHiNorm*(1-bassWeight)`. Sätt default mot bas-tungt (bassWeight → ~0.9–1.0) så grunden blir mjuk bas-pulsering. Behåll release-smoothing (softness-slidern) som mjukhetskontroll. Diskant-bidraget till grunden tonas ner; beats/drops sticker ut ovanpå.

### 6. Config + UI + diagnostik
- Nya calibration-fält: `dropEnabled`, `dropSensitivity`, `dropFlashMs` (+ ev. `beatSource` = bass/full). Defaultar enligt ovan.
- Exponera i PiMobile-kalibrering: drop-känslighet-slider + på/av, samt beat-källa.
- `bleStats`/`/status`: `dropCount`, `dropFlashActive` för att kunna verifiera att drops triggar rätt antal gånger (inte på varje kick).

## Vad som INTE ändras
- Ingen ändring av FFT-takt, hop-size, tick-takt eller BLE-gates.
- Onset-false-positive-guarden och BLE-pre-gaten (v1.0.437) lämnas orörda.
- Express-onset-pathen återanvänds för drop-flash.

## Teknisk sektion (filer)
- `pi/src/alsaMic.ts` — `bassFlux` i `BandResult`, summera sub+bas-bins, emit till `onFluxReady`.
- `pi/src/piEngine.ts` — onset på bassFlux; drop-detektor (3 EMA + state) i onFluxReady; dropFlash-override i tickInner; nya cal-fält + defaults + drop-räknare.
- `pi/src/ble/state.ts` — `dropCount`, `dropFlashActive`.
- `pi/src/configServer.ts` — exponera drop-stats i `/status`, persistens av nya cal-fält.
- `src/pages/PiMobile.tsx` (eller kalibrerings-UI) — drop-sensitivity/på-av + beat-källa-kontroller.
- `pi/package.json` — versionsbump.

## Risk / verifiering
- **Falska drops** på täta/högenergi-låtar: mitigeras av kravet på föregående breakdown + refractory; `dropSensitivity` låter dig dra åt/ifrån. Verifiera via `/status.dropCount` att en typisk EDM-låt ger ~1–3 drops, inte tiotal.
- **Kick missas** efter byte till bas-flux: justera `ABS_FLUX_FLOOR`/`onsetThreshold` för bas-bandet; verifiera mot kick-tung referenslåt.
- Bygg + tsc (pi), kontrollera att grunden känns mjuk (bara bas) och att hi-hats inte längre blixtrar.
