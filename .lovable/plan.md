

## Plan: Brightness-only BLE mode for throughput testing

### Bakgrund
Nu skickas ett 9-byte RGB-paket (`0x7e 0x07 0x05 0x03 R G B 0x00 0xef`) varje tick. Vi vill istället skicka **enbart brightness-paketet** med en fast färg, för att mäta om BLEDOM klarar högre frekvens med det kortare/enklare kommandot.

### BLEDOM brightness-paket
```
0x7e 0x04 0x01 <brightness 0-100> 0x00 0x00 0x00 0x00 0xef
```

### Ändringar

**`src/lib/bledom.ts`**
- Lägg till en ny pre-allokerad buffer: `_brightBuf = [0x7e, 0x04, 0x01, 0, 0, 0, 0, 0x00, 0xef]`
- Ändra `sendToBLE` att istället:
  1. Beräkna brightness (0-100) från scale
  2. Sätta `_pendingBrightness = brightness` (ny pending-variabel, ersätter `_pendingColor`)
  3. Ingen RGB i paketet
- Ändra `_flush()` att skicka `_brightBuf` med brightness-värdet istället för `_colorBuf`
- Behåll callback/stats som förut

**Ingen ändring i MicPanel** — `sendToBLE(r, g, b, brightness)` behåller samma signatur, men ignorerar RGB internt.

**Färgen sätts en gång vid connect** — skicka ett enda RGB-paket vid anslutning så lampan har en bas-färg att dimma.

### Resultat
Lampan kommer ha en fast färg och enbart dimmas av brightness-paketet varje tick. Du kan sedan dra slidern ner mot 25ms och se om den hänger med bättre.

