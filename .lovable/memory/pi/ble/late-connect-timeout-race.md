---
name: connectAsync withTimeout race kills successful connect
description: withTimeout(connectAsync,4000)'s setTimeout fortsätter ticka efter resolve — catch-grenen får inte disconnecta om finish() redan körts (resolved=true).
type: constraint
---
**Symptom (22:45:28-29 fältlogg):**
```
+3283ms 8. anslutning klar — engine notifierad
+4095ms connectAsync FEL: connectAsync timed out after 4000ms
+ peripheral disconnected
```
Lampan ansluter, sätter idle-färg, tappar länken ~1s senare utan reason=8.

**Rotorsak i `pi/src/ble/connect-hardcoded.ts`:**

`withTimeout(p, 4000)` är `Promise.race([p, setTimeout→reject])`. När `p` (connectAsync) resolvar fortsätter setTimeout att ticka — racet kastar ändå när timeouten fyrar. catch-blocket på connectAsync (rad ~361) kör då `peripheral.disconnectAsync()` på en peripheral vi redan satt som `_connected` och meddelat engine om.

**Regel:** I catch på connectAsync MÅSTE första check vara `if (resolved) return;` — annars dödar en sen timeout en lyckad session. Samma princip gäller alla `withTimeout(...)`-användningar i denna fil där efterföljande steg kan hinna `finish({connected:true})`.

**Inte fixat med clearTimeout:** `withTimeout` returnerar promisen från racet — vi äger inte timer-handlen utifrån. Enklast = `resolved`-flaggan vi redan har.
