

# Latency-audit och förenkling av ljud→ljus-pipelinen

## Identifierade latency-källor

### 1. **1ms sleep mellan färg och ljusstyrka i BLE flush** (bledom.ts:293)
Varje BLE-write-slot har en `await new Promise(r => setTimeout(r, 1))` mellan färg- och ljusstyrka-kommandot. `setTimeout(r, 1)` ger i praktiken **4-16ms** pga browser-clamping. Detta är den enskilt största onödiga fördröjningen.

**Fix**: Ta bort pausen — skicka brightness direkt efter color. BLEDOM-lampor hanterar back-to-back writes utan problem via `writeValueWithoutResponse`.

### 2. **`computeBands` gör dubbelt FFT-arbete** (MicPanel.tsx:330 + 395)
Tick-loopen anropar `getFloatTimeDomainData` (rad 330) för RMS och sedan `computeBands` som anropar `getFloatFrequencyData` (rad 59). Båda läser från analysern — det är korrekt att de är separata (tid vs frekvens). Men **RMS kan beräknas från frekvensdatat** istället, vilket sparar ett API-anrop.

**Fix**: Beräkna RMS från frequency-domänen inuti `computeBands` och returnera det, eliminera det separata `getFloatTimeDomainData`-anropet.

### 3. **Drop-detection gör `.slice()` varje tick** (MicPanel.tsx:454-455)
`bassHist.slice(-8)` och `.slice(-60, -8)` allokerar nya arrayer 40x/s. Liten men onödig GC-press.

**Fix**: Beräkna medelvärden med index-loopar direkt på arrayen istället för slice.

### 4. **`performance.now()` anropas 5+ gånger per tick**
Fyra separata `performance.now()`-anrop för pipeline-timings (rad 326, 334, 499, 518) plus `now` för drop-detection. 

**Fix**: Cacha ett enda `performance.now()` i tickens start, återanvänd för allt utom BLE-timing.

### 5. **AGC save varje 10s gör `saveCalibration` med localStorage-write** (rad 528-534)
`saveCalibration` skriver till localStorage i tick-kontexten. Inte kritiskt men onödigt i hot path.

**Fix**: Flytta AGC-save till en separat `setInterval` utanför tick-loopen.

### 6. **`applyColorCalibration` + `modulateColor` körs varje tick** (rad 511-513)
Två funktionsanrop med Math-operationer varje tick även om färgen inte ändrats.

**Fix**: Cacha kalibrerad färg och bara räkna om när `colorRef` eller calibration ändras.

## Förenklingar

### 7. **`whiteKickUntilRef` är oanvänd/dead code**
`whiteKickUntilRef` sätts aldrig (ingen kick-logik kvar), men läses fortfarande i `onBleWrite`-callbacken (rad 554). Drop-systemet har ersatt det.

**Fix**: Ta bort `whiteKickUntilRef` helt, ersätt med `dropActiveUntilRef` i callbacken.

### 8. **`beatPhaseRef` och `lastBeatTimeRef` — oanvända**
Deklarerade (rad 152-153) men aldrig skrivna eller lästa.

**Fix**: Ta bort.

### 9. **`dropDurationMod` beräknas men överskriver drop-duration efter att den redan satts**
Rad 489-497: `dropDurationMod` skriver om `dropActiveUntilRef` efter att den redan beräknats med `surgeStrength`. Dubbel logik.

**Fix**: Konsolidera — inkludera `traitEnergy` i den initiala drop-duration-beräkningen och ta bort efterjusteringen.

## Sammanfattning av vinster

| Åtgärd | Uppskattad vinst |
|--------|-----------------|
| Ta bort 1ms sleep i BLE flush | **4-16ms per frame** |
| Eliminera dubbel analyser-read | ~0.1-0.3ms |
| Slice → index-loopar | GC-reducering |
| Cacha performance.now() | ~0.05ms |
| Ta bort dead code | Renare kodbas |

Den stora vinsten är punkt 1 — den falska 1ms-pausen kostar reellt 4-16ms per BLE-slot.

## Implementationsplan

1. **Ta bort 1ms sleep** i `_flush()` i bledom.ts
2. **Slå ihop RMS + bands** till ett enda `computeBands`-anrop som returnerar RMS
3. **Drop-detection utan slice** — inline index-loopar
4. **Rensa dead code**: `whiteKickUntilRef`, `beatPhaseRef`, `lastBeatTimeRef`, dubbel drop-duration
5. **Cacha `performance.now()`** i tick-start
6. **Flytta AGC-save** till separat interval

