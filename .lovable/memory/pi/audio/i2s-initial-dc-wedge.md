---
name: I2S DC-wedge orsakas av arecord-verifiering
description: Att köra arecord för att "verifiera hårdvaran" lämnar I2S i ett läge där motorns nästa öppning ger konstant DC (midHi exakt 0). Kör aldrig arecord före motorstart.
type: constraint
---

ROTORSAK (bekräftad 2026-08-29): Den "initiala I2S-DMA-wedgen" (raw konstant ~0.0069, midHi exakt 0.00000) uppstod bara när `arecord` körts strax innan motorn öppnade enheten. Hoppa över arecord-kontrollen → micen är stabil (20/20 unika mätpunkter över 3 min, spann 0.077–0.812).

**Förbjudet:** använd inte `arecord` som hälsokontroll på Pi:n, varken manuellt eller i skript. Det förorenar enheten och det test det ska verifiera.

**Ogiltiga slutsatser** (mättes med arecord inblandat, ska inte litas på förrän ommätt):
- buffert 8× vs 16× periods
- `sw_params` / `set_periods_near`-känslighet

**Står kvar:** frys-detektorns falska larm var en verklig kodbugg (absolut tolerans 0.00002 på 130 ms EMA → `process.exit(1)`); fixad med 2 % relativ tolerans + 15 s fönster, och process-restart bara vid byte-identisk hard-freeze.
