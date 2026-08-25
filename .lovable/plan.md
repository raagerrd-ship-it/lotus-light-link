# BLE write-stall-release: koppla till tickMs

## Varför inte 24 ms

`WRITE_PENDING_TIMEOUT_MS` avbryter ingenting. En `writeAsync(buf, true)` (withoutResponse) kan inte ångras — paketet ligger redan i nobles ACL-kö/HCI-socket. Flaggan `writePending` är bara vår egen slot-markering, och timeouten är en säkerhetsventil för att flaggan inte ska fastna `true` för evigt om promiset aldrig settlar.

Konsekvenser av 24 ms:

- Takten blir inte snabbare. `slotLockedUntil = now + slotLeaseMs` (= tickMs, 25 ms) är det som sätter cadencen — den släpps aldrig i förtid.
- En normal latensspik (30–80 ms över radio händer) skulle räknas som stall, släppa sloten, och nästa tick lägger på ett extra paket. `outstanding` stiger mot taket 6 → ACL-gaten blockerar ändå, men nu med staplade paket = lampan halkar efter ljudet.
- `writeStallReleaseCount` skulle ticka konstant och göra räknaren värdelös som stall-signal.

## Vad som faktiskt är värt att ändra

Gör siffran relativ till tickMs i stället för hårdkodad 150, så den skalar om tickMs ändras (25 → 40 ms t.ex.):

- I `pi/src/ble-driver/protocol.ts`: ersätt konstanten `WRITE_PENDING_TIMEOUT_MS = 150` med en funktion som returnerar `clamp(slotLeaseMs * 6, 100, 300)`. Vid tickMs 25 ger det 150 ms — dvs oförändrat beteende idag, men självjusterande.
- Använd den på båda ställena den läses: `leaseAndDrainState()` och `canWriteNow()`.
- Exponera det effektiva värdet i `bleStats` (t.ex. `writeStallTimeoutMs`) så `/api/status` visar vad som gäller.

Ingen ändring av lease-logiken, ACL-gaten (tak 6) eller stuck-detektionen.

## Om målet är lägre latens

Rätt reglage är inte stall-timeouten utan:

- `tickMs` (25) — styr hur ofta ett paket får skickas.
- BLE connection interval (7.5–15 ms via `forceConnInterval`) — styr hur snabbt controllern faktiskt sänder.
- `beatLeadMs` (45) — kompenserar kvarvarande latens genom att skicka före beatet.
