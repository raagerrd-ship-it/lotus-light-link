

# Stabilitetsöversikt efter senaste refaktoreringen

Koden är betydligt bättre efter senaste genomgången. Kvarvarande problem:

## Problem 1: `retryCount` — dead state
`retryCount` (Index.tsx rad 40) sätts till 0 i `finishConnect` men **inkrementeras aldrig**. Det är oanvänt i UI:t och JSX. Ren dead code.

**Fix:** Ta bort `retryCount` och `setRetryCount` helt.

## Problem 2: `start()` har `char` som dependency men använder det inte
`start` callback (MicPanel.tsx rad 159) har `[char]` som dependency array, men inne i funktionen används bara `charRef` (via `createBleQueue(charRef)`). Detta orsakar att `start` återskapas vid varje `char`-ändring, men det har ingen effekt — `charRef` uppdateras redan via useEffect. Den onödiga dependency gör att `useEffect` på rad 701-706 kan trigga `start()` i onödan vid reconnect (skapar ny AudioContext + mikrofon-stream trots att den gamla fortfarande kör).

**Fix:** Ta bort `char` ur dependency-arrayen. Auto-start-effekten på rad 701 triggas redan av `char`-ändringen, men `start` bör vara stabil.

## Problem 3: Dubbel audio-pipeline vid reconnect
Om BLE tappar anslutningen och användaren reconnectar:
1. `connection` sätts till `null` → `char` blir `undefined`
2. Ny anslutning → `char` får nytt värde
3. useEffect rad 701: `if (char && !active)` — men `active` är fortfarande `true` från förra sessionen (inget har satt det till false)
4. Resultat: `start()` anropas **inte**, men den gamla rAF-loopen kör fortfarande med `charRef` som nu pekar på den nya characteristic — det fungerar, men av en slump snarare än design.

Om disconnect-handleren på Index.tsx sätter `connection = null` → `char = undefined` → MicPanel får `char=undefined` → `charRef.current = undefined` → BLE-kommandon silently droppas → det **fungerar** men progress-ringen och visualiseraren fortsätter utan att BLE-kommandon skickas. Sedan vid reconnect uppdateras `charRef` och allt fungerar igen.

**Bedömning:** Faktiskt stabil trots att flödet är implicit. Inget behöver ändras här, men en kommentar vore bra.

## Problem 4: `finishConnect` fångar `currentColor` i closure
`finishConnect` (Index.tsx rad 72) har `currentColor` i dependency-arrayen. Om Sonos ändrar färg innan man ansluter skickas den senaste färgen — **korrekt beteende**. Men `finishConnect` återskapas vid varje färgbyte, vilket påverkar `handleConnect` och `handleReconnect`. Ingen bugg, men onödigt.

**Fix:** Använd en ref för `currentColor` i `finishConnect` istället.

## Sammanfattning av ändringar

1. **Ta bort `retryCount`** — dead state i Index.tsx
2. **Ta bort `char` ur `start`-dependency** — förhindra onödig re-creation av audio pipeline
3. **Ref-ifirera `currentColor` i `finishConnect`** — stabilisera callback-identitet
4. **Lägg till kommentar** om att charRef-mönstret hanterar reconnect implicit

Alla ändringar i 2 filer: `Index.tsx` och `MicPanel.tsx`. Inga funktionella beteendeändringar — bara stabilisering.

