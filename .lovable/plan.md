

# Två BLE-vägar med tydlig owner-växling

## Mål

EN väg är alltid aktiv när BLE är ansluten — aldrig båda samtidigt, aldrig ingen.

- **Idle-vägen** (keep-alive-loopen) är default. Startar när BLE ansluter. Bär idle-färgen @ 200ms.
- **Aktiva vägen** (`sendToBLE` per FFT-tick) tar över när Sonos rapporterar `playing`. Idle-loopen pausas helt under tiden.
- När Sonos går till `paused`/`stopped`/TV → idle-vägen återupptas inom samma tick.

## Nuvarande problem

I dag kör keep-alive-loopen ALLTID när BLE är ansluten — även mitt under musik. Det betyder att idle-keepalive och `sendToBLE` slåss om samma single-slot, vilket:
1. Ökar `skipBusyCount` under play (keep-alive konkurrerar med mic-writes).
2. Gör ägarskapet otydligt: vem äger `writeBuf`-state under play?
3. Räknar keep-alive-paket i `pkt/s` även under play, vilket skuggar det riktiga mic-flödet.

## Lösning — explicit owner-switch

### `pi/src/ble/protocol.ts`
- Behåll `startKeepAlive`/`stopKeepAlive` men gör dem till den enda idle-mekanismen.
- Sänk `KEEPALIVE_MS` till **200ms** (idle-färg-byte syns inom 200ms vid pause).
- Ny exporterad `setIdleColor(r, g, b)` — synkron buffer-uppdate, ingen write. Keep-alive bär färgen vid nästa tick.
- Ta bort `sendIdleForce` och `sendRawColor` (enligt tidigare plan).

### `pi/src/piEngine.ts` — owner-switch
Nytt internt state: `_bleOwner: 'idle' | 'active' | 'none'`.

Övergångar:
| Event | Från | Till | Action |
|---|---|---|---|
| `onBleConnected` | none | idle | `setIdleColor(idle)` + `startKeepAlive()` |
| `setPlaying(true)` | idle | active | `stopKeepAlive()` — `tickInner` tar över via `sendToBLE` |
| `setPlaying(false)` | active | idle | `setIdleColor(idle)` + `startKeepAlive()` |
| `onBleDisconnected` | * | none | `stopKeepAlive()` |

`tickInner` returnerar tidigt om `_bleOwner !== 'active'` (skyddar mot race där en sen FFT-frame försöker skriva efter pause).

### `pi/src/configServer.ts`
Radera `/api/ble-fade-test`-endpoints + `sendRawColor`-import (enligt tidigare plan).

### Diagnostik
- `forceIdleNow()` uppdaterar `_diag.finalR/G/B` + `_tickData.color` så UI:t visar idle-färgen direkt vid pause (redan gjort i tidigare iteration, behålls).
- `bleStats.sentCount` räknar bara writes från den **aktiva ägaren** — keep-alive räknar i idle, `sendToBLE` räknar i play. Aldrig båda. UI:t visar ~5 pkt/s i idle, mic-rate i play.

## Resultat

```text
BLE connected ──► idle (keep-alive @200ms, idle-färg)
                       │
                  Sonos playing
                       ▼
                   active (sendToBLE per tick)
                       │
                  Sonos paused
                       ▼
                  idle (keep-alive återupptas)
```

EN ägare i taget. Inga konkurrerande writes. `pkt/s` säger sanningen om vilken väg som är aktiv.

## Filer

- `pi/src/ble/protocol.ts` — radera `sendRawColor`+`sendIdleForce`, lägg till `setIdleColor`, `KEEPALIVE_MS=200`.
- `pi/src/ble/index.ts` — uppdatera exports.
- `pi/src/piEngine.ts` — `_bleOwner` state, owner-switch i `onBleConnected`/`onBleDisconnected`/`setPlaying`, tick-guard.
- `pi/src/configServer.ts` — radera fade-test-endpoints.
- `pi/src/sonosPoller.ts` — uppdatera kommentar.
- `mem://pi/ble/single-slot-write-contract` — dokumentera owner-modellen.
- Radera `mem://pi/ble/idle-force-on-pause` (inaktuell).

