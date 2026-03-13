

# Lägg till GetVolume i Cast Away Web + ta bort separat sonos-local-proxy-beroende

## Problem
Appen (Ljusår) använder Cast Away Web:s proxy (`localhost:3000/api/sonos/status`) — inte den separata `sonos-local-proxy`. Cast Away returnerar inte `volume` i sitt status-svar, så kalibreringsfunktionen får aldrig volymdata.

## Plan

### 1. Cast Away Web — `bridge/index.js` (rad ~2001–2075)
Lägg till `GetVolume` SOAP-anrop parallellt med de befintliga tre:

```javascript
const volBody = `<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`;

const [posXml, transXml, mediaXml, volXml] = await Promise.all([
  soapRequest(posBody, 'GetPositionInfo'),
  soapRequest(transBody, 'GetTransportInfo'),
  soapRequest(mediaBody, 'GetMediaInfo'),
  soapRequest(volBody, 'GetVolume', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null)
]);

// Parse volume
let volume = null;
if (volXml) {
  const volStr = extractTag(volXml, 'CurrentVolume');
  if (volStr !== null) volume = parseInt(volStr, 10);
}
```

Inkludera `volume` i JSON-svaret (rad 2063):
```javascript
sendJson(res, { ...existing, volume });
```

Kräver att `soapRequest` stödjer custom `controlPath` och `serviceType` — behöver verifiera signaturen i Cast Away.

### 2. Ljusår — ingen ändring behövs
`useSonosNowPlaying.ts` parsar redan `volume` från status-svaret (implementerat i förra meddelandet). Allt fungerar automatiskt så fort Cast Away börjar skicka `volume`.

### 3. `sonos-local-proxy/` i Ljusår
Kan behållas som referensimplementation/dokumentation, men den körs inte. Ingen ändring krävs.

## Sammanfattning
En enda ändring i Cast Away Web:s `bridge/index.js` — lägga till `GetVolume` SOAP-anrop och inkludera `volume` i status-svaret. Sedan fungerar hela kalibreringspaketet i Ljusår.

