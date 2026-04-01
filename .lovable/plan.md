

## Slutsats: Write gate hjälper inte — tidsspärr istället

### Varför write gate inte fungerar
`writeValueWithoutResponse` resolvar direkt (sub-ms) när datan lämnas till OS-bufferten, inte när den sänts. Flaggan `_writing` hinner alltid resetta sig innan nästa tick — den blockerar aldrig.

### Nuläge
Dedupliceringen (skippa identiska paket) är redan implementerad och fungerar. Det som saknas är skydd mot att skicka *olika* värden för snabbt.

### Plan: Lägg till minsta skriv-intervall

**Fil: `src/lib/engine/bledom.ts`**

1. Lägg till `let _lastWriteTime = 0` modulvariabel
2. I `sendToBLE()`, efter dedup-check men före write:
   - `const now = performance.now()`
   - Om `now - _lastWriteTime < MIN_WRITE_INTERVAL_MS` → return (skippa)
   - Sätt `_lastWriteTime = now` efter godkänd check
3. `MIN_WRITE_INTERVAL_MS` sätts till tickMs-värdet (default ~125ms) så att vi aldrig skickar snabbare än en gång per tick
4. Nollställ `_lastWriteTime` i `resetLastSent()` (vid reconnect)

**Inga andra filer ändras.** Tillsammans med befintlig dedup ger detta fullständigt skydd mot köbildning.

### Teknisk detalj
```text
tick() → sendToBLE()
          ├─ dedup: samma värde? → skip ✓ (finns redan)
          ├─ throttle: för snart? → skip (NYTT)
          └─ write + uppdatera _lastWriteTime
```

