---
name: Ingen lokal Sonos-gateway
description: Gatewayen (Sonos Buddy/Cast Away) körs på brew-Pi:n sedan 2026-08-29 — inga 127.0.0.1-fallbackar, adress alltid explicit
type: constraint
---

Sonos Buddy + Cast Away flyttades från lotus-Pi:n (Zero 2 W) till brew-Pi:n (Pi 5)
2026-08-29 för att frigöra minne (146 → 217 MB fritt).

Förbjudet:
- localhost/127.0.0.1-fallback för gateway-adress (i `index.ts`, `configServer.ts`, `sonosPoller.ts`).
- `startSonosPoller()` utan explicit adress (default-argumentet är borta).
- `/api/sonos-gateway/detect` och "Lokal/Extern"-läget i UI (borttagna — en localhost-scan kan bara ge felaktiga adresser).

Krav:
- Sparad eller inskickad lokal adress ignoreras med varning; PUT `/api/sonos-gateway` svarar 400.
- Saknad adress → tydligt fel + `markSubsystemError('sonos', ...)`, aldrig tyst frusen IDLE.
- `/api/status.sonosGateway` = `{ gatewayUrl, error, dataAgeMs }`; subsystem-status `sonos` degraderas från `ready` när ingen data kommit in på 30 s.
- SSE safety-poll (5 s) behålls.

**Why:** tyst localhost-fallback gav en frusen IDLE-state som såg ut som nätverksfel under flytten.
