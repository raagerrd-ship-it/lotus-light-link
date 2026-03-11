

# Kodgranskning: Stabilitet och SSOT-problem

## Identifierade problem

### 1. `durationMs` i MicPanel's rAF-loop refererar till prop direkt (ej ref)
MicPanel.tsx rad 520: `const dur = durationMs;` — inne i rAF-loopens closure som skapas en gång (`[active]`-dependency). `durationMs` fångas vid mount och uppdateras aldrig. Progressringen slutar fungera om duration ändras (ny låt).

**Fix:** Lägg till `durationMsRef` likt `sonosPositionRef` och `currentColorRef`.

### 2. `bleQueueRef` skapas med `char` vid `start()` men uppdateras aldrig
Om `char` ändras (reconnect) körs `start()` igen via `useEffect([char])`, men den gamla loopen fortsätter köra med gamla queuen tills `active` ändras. Kan leda till att kommandon skickas till gammal (frånkopplad) characteristic.

**Fix:** Skapa en `charRef` och låt queuen läsa från den, eller avbryt rAF-loopen vid char-byte.

### 3. `autoConnecting` state är hårdkodad till `false` — dead code
Rad 35: `const [autoConnecting] = useState(false)` — aldrig satt till true. Ändå kollas den i render (rad 213). Rensa bort helt.

### 4. `reconnectLastDevice` i bledom.ts har kvar Strategy 1+2 som vi konstaterat inte fungerar
Funktionen returnerar alltid `null` i praktiken på Desktop Chrome. Anropas fortfarande från `handleReconnect` (rad 172) och `setupDisconnectHandler` (rad 79). Disconnect-handlern gör 3 retries som alla misslyckas — onödig väntan.

**Fix:** `reconnectLastDevice` bör vara en no-op eller tas bort. `handleReconnect` ska gå direkt till `connectBLEDOM(false)`.