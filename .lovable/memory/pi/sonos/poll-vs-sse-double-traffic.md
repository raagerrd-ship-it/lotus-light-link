---
name: Poll-timern får aldrig re-armas när SSE är aktiv
description: sonosPoller.ts — arm()-callbacken sätter pollTimer=null före await, så stopPollTimer() missar en in-flight poll. Kolla sseActive både först i callbacken och i finally före re-arm.
type: constraint
---
**Bugg:** `arm()`-callbacken nollar `pollTimer` före `await fetch`. Om SSE `onopen` kör `stopPollTimer()` under den fetchen hittar den `null` och rensar inget → pollens `finally` armar en ny timer som SSE inte kan stoppa → dubbel Sonos-trafik för alltid på den delade radion.

**Regel (v1.0.767):**
```ts
pollTimer = null;
if (sseActive) return;          // SSE tog över medan timern var armerad
...
} finally {
  pollInFlight = false;
  if (!sseActive) arm(currentPollMs());
}
```
Plus: `stopSonosPoller` måste använda `clearTimeout` (handle är ett setTimeout, inte setInterval).
