

## Du har rätt — Attack/Release-slidrarna styr bara engine-smoothing, inte mic-stadiet

### Var slidrarna faktiskt går idag

UI Attack/Release → `cal.attackAlpha` / `cal.releaseAlpha` → används **bara** i `piEngine.ts` rad 644 på den slutgiltiga `energyNorm`-signalen (efter dynamics, gamma, allt).

Mic-stadiet (`alsaMic.ts`) har **egna hårdkodade konstanter**:
- `RMS_ATTACK_ALPHA = 0.8` (rad 184)
- `RMS_RELEASE_ALPHA = 0.15` (rad 185)
- `NOISE_GATE_KNEE = 3.0` (rad 199)
- `NOISE_FLOOR_TRACK_ALPHA = 0.001` (rad 198)

Slidrarna i UI:t har alltså aldrig påverkat bas-detektering eller noise-gate — bara den sista smoothing-stegen i engine. Det är därför du upplever segheten även efter att du dragit upp Attack.

### Förslag: koppla ihop hela kedjan med samma Attack/Release

Använd **samma** `attackAlpha`/`releaseAlpha` från profilen för:

1. **`alsaMic.ts` `smoothRms`** (bas + mid/hi pre-smoothing) → ersätter `RMS_ATTACK_ALPHA` / `RMS_RELEASE_ALPHA`
2. **`alsaMic.ts` noise-floor tracking** → härleds från release-värdet (snabbare release = snabbare gate-recovery)
3. **`piEngine.ts` rad 644** (befintlig användning) → oförändrad

På så vis betyder Attack=100 verkligen "ingen smoothing någonstans i kedjan" och Release=0 betyder "rått fall överallt".

### Konkret mappning

I `alsaMic.ts` läggs en exporterad setter som engine anropar när profil byts:

```ts
let micAttackAlpha = 0.8;   // default = nuvarande beteende
let micReleaseAlpha = 0.15; // default = nuvarande beteende
let micGateRecoveryAlpha = 0.05; // default snabb recovery

export function setMicSmoothing(attackAlpha: number, releaseAlpha: number) {
  micAttackAlpha = attackAlpha;
  micReleaseAlpha = releaseAlpha;
  // Gate-recovery: snabbare när release är snabbt (motverkar samma symptom)
  micGateRecoveryAlpha = Math.max(0.01, releaseAlpha * 0.3);
}
```

`smoothRms` använder `micAttackAlpha`/`micReleaseAlpha` istället för konstanterna.
`applyNoiseGate` använder `micGateRecoveryAlpha` istället för `NOISE_FLOOR_TRACK_ALPHA` på "rising"-vägen (asymmetrisk floor tracking, snabb upp).

### Var setter:n anropas

I `piEngine.ts` där `cal` uppdateras (init + profil-byte). En enda rad:
```ts
setMicSmoothing(cal.attackAlpha, cal.releaseAlpha);
```

### "Inför alla" — defaults i `configServer.ts`

Befintliga profil-defaults är redan rimliga; mappningen ger automatiskt:

| Profil  | Attack (UI) | Release (UI) | Mic attack | Mic release | Gate recovery |
|---------|-------------|--------------|------------|-------------|---------------|
| Lugn    | ~25         | ~75          | 0.061      | 0.025       | 0.0075 (långsam) |
| Normal  | 100         | ~75          | 1.0        | 0.025       | 0.0075 |
| Party   | 100         | ~75          | 1.0        | 0.025       | 0.0075 |
| Custom  | 100         | ~75          | 1.0        | 0.025       | 0.0075 |

**Problem:** Release-defaults idag (`0.025`) ger fortfarande långsam gate-recovery (~3s efter tystnad). Om du vill få bort segheten efter tysta passager **utan** att ändra UI-känslan behöver vi också:

**Förslag (valbart):** Gör gate-recovery delvis frikopplad — använd `max(releaseAlpha * 0.3, 0.03)` så att även Lugn får ~100ms gate-recovery efter tystnad, medan UI-release fortfarande styr själva fall-tiden.

### Filer som ändras

- **`pi/src/alsaMic.ts`** — gör `RMS_ATTACK_ALPHA`/`RMS_RELEASE_ALPHA` till mutable variabler + ny `setMicSmoothing()` export + asymmetrisk `noiseFloor` tracking baserat på samma värde (~10 rader).
- **`pi/src/piEngine.ts`** — anropa `setMicSmoothing(cal.attackAlpha, cal.releaseAlpha)` när cal sätts/uppdateras (1 rad i `applyCalibration` eller motsvarande).
- **`mem://pi/audio/signal-processing-chain.md`** — uppdatera: mic-smoothing styrs nu av samma Attack/Release som engine.
- **`mem://pi/ui/softness-slider-curve.md`** — uppdatera: kurvan styr nu hela kedjan, inte bara engine-smoothing.

### Vad du får

- Attack-slidern påverkar nu **mic→engine→ljus** överallt — sätter du 100 är pipelinen helt utan smoothing-fördröjning.
- Release-slidern styr både den hörbara fall-tiden och hur snabbt noise-gaten återhämtar sig efter tystnad.
- Profilerna fungerar identiskt som idag på låga UI-värden (samma defaults).
- Inga UI-ändringar behövs — slidrarna finns redan.

### Vad vi INTE rör

- Tick-rate, FFT-storlek, BLE — orelaterat.
- `dynamics`, `gamma`, `bassWeight` — separata kontroller.
- UI-komponenter — slidrarna existerar redan i `ProfileSettingsView`.

### Reversibelt

Lägger en env-flagga `MIC_SMOOTHING_FROM_CAL=false` som faller tillbaka till hårdkodade konstanter ifall ändringen orsakar oväntat beteende.

