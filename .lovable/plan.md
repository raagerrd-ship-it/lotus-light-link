

# Ljusår – Styr ditt ljus

En minimalistisk webbapp för att styra din BLEDOM01 LED-slinga via Bluetooth, designad som ett instrument för att måla rummet med ljus.

## Upplevelsen

### Startskärm
En mörk skärm (`#121212`) med en stor, centrerad knapp: **"VÄCK LJUS"**. Vid klick ansluter appen till din BLEDOM01 via Web Bluetooth.

### Huvudskärm (en enda vy, ingen navigation)

Tre zoner efter anslutning:

1. **Övre zonen (15%)** – Enhetsnamn "BLEDOM01" + en "Stäng av"-knapp
2. **Mellersta zonen – "Duken" (70%)** – En stor interaktionsyta för färgval:
   - **Dra horisontellt** = ändra färgton (Hue) genom regnbågens spektrum
   - **Dra vertikalt** = ändra mättnad (Saturation), från full färg (nere) till vitt (uppe)
   - Ljusslingan uppdateras i realtid medan fingret rör sig
   - Appens bakgrund tonas subtilt mot den valda färgen
3. **Nedre zonen (15%)** – Ett horisontellt reglage för ljusstyrka

### Bluetooth-kommunikation
- Ansluter till enheten via Web Bluetooth API med UUID `0000fff3-0000-1000-8000-00805f9b34fb`
- Skickar färg- och ljusstyrkekommandon i BLEDOM-protokollet (7-byte-format)
- Hanterar av/på, färg (RGB) och ljusstyrka

### Design
- **Typsnitt:** Space Mono (rubriker/UI), Inter (hjälptext)
- **Färger:** Mörk bakgrund #121212, off-white text #EAEAEA, inaktiva element #555555
- **Accent:** Den exakta färgen som ljusslingan visar just nu – appen speglar ljuset
- **Känsla:** Minimalistiskt, taktilt, ingen meny eller inställningar

### PWA-stöd
Appen görs installerbar så du kan lägga den på hemskärmen som en vanlig app.

