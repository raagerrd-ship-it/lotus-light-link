---
name: Initial I2S DC-wedge — invänta ioctl-diff
description: Motorns första ALSA-open wedgar I2S till ett konstant ord trots frisk arecord precis före. ALSA är RUNNING utan parameterfel; gör inga fler hypotespatchar före strace ioctl-diff mot arecord.
type: constraint
---
**Verifierat på Pi efter v1.0.787:**
- `arecord` direkt före motorstart: cirka 3996 unika sampel — hårdvaran är frisk.
- Motorns första öppning: `rawRms ≈ 0.00693` konstant, `bass ≈ 0.00693`, `midHi = 0.00000` exakt.
- Detta är ett konstant I2S-ord/ren DC, inte vanlig tystnad; en fungerande mikrofon har alltid något växelinnehåll/brus.
- ALSA rapporterar `RUNNING`, period/buffer `256/4096`, `hw_ptr` rör sig och loggen saknar både `Unable to set HW params` och `sw_params:`-fel.
- Wedgen uppstår vid första motoröppningen direkt efter verifierat frisk capture, alltså innan någon restart-loop.

**Slutsats:**
- Den korrigerade stable-RMS-frysdetektorn ska behållas; dess tidigare falska larm var en separat verklig bugg.
- `periods_near(16)`, 16×-bufferten och SW-parametrarna accepteras och ska inte rullas tillbaka på nuvarande evidens.
- Gör inga fler gissningsbaserade ändringar i öppningssekvensen. Nästa diagnostiska steg är en `strace -e trace=ioctl`-diff mellan fungerande `arecord` och motorns första ALSA-open på den fysiska Pi:n.