

# Visuella förbättringar

Jag ser flera saker som kan poleras:

## 1. Reconnecting-skärmen — tråkig och kall
Bara en spinner + text. Kan få samma glow-accent som connect-skärmen och visa enhetsnamnet.

## 2. Connect-skärmen — Bluetooth-ikonen saknar liv
Den statiska cirkeln med Bluetooth-ikon kan få en subtil pulsande glow i accent-färgen.

## 3. NowPlayingBar — platt och anonym
Albumomslaget saknar glow/accent. BPM-visningen smälter in i artist-texten. Kan förbättras med en svag glow-border runt albumart och en tydligare BPM-badge.

## 4. Overlay-header — "Vit kick"-texten ser provisorisk ut
Checkbox + label-kombination i headern ser ut som debug-UI. Kan bli en snyggare liten toggle-pil eller ikon-knapp.

## Ändringar

### `src/pages/Index.tsx`
- **Reconnecting-skärmen**: Lägg till accent-glow bakom spinnern och visa `lastDevice.name`
- **Connect-skärmen**: Lägg till `animate-pulse` + `box-shadow` med accent-färg på Bluetooth-cirkeln
- **Overlay-header**: Byt ut Checkbox + text mot en kompakt ikon-toggle (t.ex. `Zap`-ikon som tonar i accent-färg när aktiv)

### `src/components/NowPlayingBar.tsx`
- Lägg till accent-glow på albumart: `boxShadow` baserad på `currentColor` (behöver ta emot färg som prop)
- Separera BPM till en liten badge med `bg-secondary` och `font-mono` styling
- Ta bort Music-ikonen (redundant när albumart visas)

---

Fem visuella justeringar, inga beteendeändringar. Appen ska kännas mer som en dedikerad kontroller och mindre som ett dev-verktyg.

