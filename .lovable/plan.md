

# Logaritmisk fade-out för vit kick

## Nuläge

Fade-out från vit kick till basfärg är **binär**: när `curved <= 0.95` snäpper den direkt tillbaka till basfärgen i ett enda BLE-kommando. Ingen gradvis nedtoning.

Fade-in (boost) är också en snäpp — den beräknar en boost-faktor `(curved - 0.98) * 25` men skickar bara ett kommando vid tröskeln.

## Problem

Mänsklig ljusperception är logaritmisk — en linjär nedtoning ser ut att "hänga kvar" för länge i det ljusa och sedan plötsligt bli mörk. En logaritmisk kurva matchar ögats känslighet bättre.

## Plan

### Gradvis fade-out med logaritmisk kurva

Istället för binär on/off, tracka **tiden sedan boosten startade** och beräkna fade-out som en logaritmisk decay:

1. **Ny ref:** `boostStartRef = useRef<number>(0)` — tidsstämpel när senaste vita kicken triggades.

2. **På kick-trigger** (curved > 0.98): spara `boostStartRef.current = now`.

3. **Fade-out** (varje frame efter kick): Beräkna `elapsed = now - boostStartRef.current`. Fade-duration = `beatMs * 0.6` (60% av ett beat). Beräkna t:

```text
t_linear = clamp(elapsed / fadeDuration, 0, 1)
t_log    = 1 - Math.pow(1 - t_linear, 3)   // kubisk ease-out (perceptuellt logaritmisk)
```

Interpolera från boost-färg → basfärg med `t_log`. Skicka BLE-kommando throttl