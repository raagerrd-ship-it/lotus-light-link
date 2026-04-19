
Problemet jag ser är att koden just nu blandar ihop två olika saker:

- `raw noble state` = vad noble själv rapporterar (`unknown` i dina loggar)
- `effektiv BLE-motor redo` = OS/HCI/caps säger att radion i praktiken är uppe (`poweredOn` via override)

Det är därför du får motsägelsefulla rader som:
- `noble:unknown→poweredOn`
- `pow✗`
- boot-logg som säger att noble inte blev poweredOn, trots att BLE-motorn i praktiken verkar vara uppe

Dessutom finns en policyglipa kvar: `scan.ts` har fortfarande respawn-logik, trots att ni beslutat manual-only utan auto-respawn.

## Plan

### 1. Separera statusbegreppen i backend
Uppdatera `pi/src/ble/state.ts` och `pi/src/ble/heartbeat.ts` så att tre saker hålls isär tydligt:

- rå noble-state
- effektiv BLE-motor redo
- stateChange observerad ja/nej

I stället för dagens otydliga `pow✓/✗` ska heartbeat/loggar använda en tydligare etikett för “noble stateChange sedd” och visa rå/effektiv status sida vid sida utan att se ut som samma sak.

### 2. Korrigera boot- och diagnostiklogiken
Uppdatera `pi/src/index.ts` och `pi/src/configServer.ts` så boot inte längre kommunicerar “BLE trasig” när det egentligen bara är raw noble som inte syncat.

Det ska bli två separata diagnoser:

- “BLE-motor redo”
- “noble raw/stateChange ej bekräftad ännu”

Checklistan i diagnostiken ska fortsätta visa exakta steg, men med tydligare innebörd så användaren ser vad som faktiskt passerats.

### 3. Synka BLE-policy i scan/connect
Gå igenom `pi/src/ble/scan.ts` och vid behov `pi/src/ble/connect.ts` så BLE-operationer följer samma policy som resten av systemet:

- ingen auto-respawn kvar i scan-flödet
- konsekvent readiness-logik i stället för att vissa delar litar på effektiv state och andra kräver rå `poweredOn`
- tydligare felmeddelanden om exakt vad som blockerar nästa steg

### 4. Justera UI-texten, inte layouten
Uppdatera `src/pages/PiMobile.tsx` men behåll checkbox-layouten.

Målet är att panelen ska visa ungefär detta tydligt:

- BLE-motor: redo / väntar / behöver åtgärd
- noble raw state: unknown / poweredOn
- stateChange fångad: ja / nej
- lampa/mic/sonos som egna grupper som idag

Alltså samma visuella modell som du vill ha, men utan att statusorden motsäger varandra.

## Förväntat resultat
Efter ändringen ska samma situation inte längre se ut som ett logiskt fel. Om adaptern är uppe men raw noble fortfarande är `unknown`, ska UI och loggar uttryckligen säga just det, i stället för att blanda ihop “motorn redo” med “noble fullt synkad”.

## Filer
- `pi/src/ble/state.ts`
- `pi/src/ble/heartbeat.ts`
- `pi/src/index.ts`
- `pi/src/configServer.ts`
- `pi/src/ble/scan.ts`
- eventuellt `pi/src/ble/connect.ts`
- `src/pages/PiMobile.tsx`
