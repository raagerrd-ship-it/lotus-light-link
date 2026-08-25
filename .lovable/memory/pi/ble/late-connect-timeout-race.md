---
name: withTimeout måste clearTimeout + yttre scan-timer clearas vid match
description: connect.ts — withTimeout clearar sin rej-timer i .finally(); onDiscover clearTimeout(timer) vid match. Därför behövs INGA resolved-vakter i catch-grenarna.
type: constraint
---
**Historiskt symptom (22:45:28-29 fältlogg):** lampan anslöt, sen kastade en sen `connectAsync timed out after 4000ms` och catch-grenen disconnectade en LYCKAD session. Även yttre scan-timern (6000ms) kunde fyra mid-GATT (8000ms) → falskt "connect failed" → `_consecutiveFailures++` → `process.exit(0)`.

**Rätt fix (v1.0.767, ersätter den gamla `resolved`-vakt-workarounden):**
1. `withTimeout` clearar sin interna `setTimeout(rej)` vid settle:
   ```ts
   return Promise.race([p, timeout]).finally(() => clearTimeout(t));
   ```
   → ingen armerad rej-timer lämnas efter en lyckad call.
2. `onDiscover` kör `clearTimeout(timer)` högst upp när `matched = true` → yttre timern bounder BARA scan→match, aldrig connect-fasen.

**Följd:** de fyra `if (resolved) return;`-vakterna i catch-grenarna och yttre timerns `if (matched)`-gren är onåbara och är RADERADE. Lägg inte tillbaka dem — de maskerar bara att en timer inte clearats.

Vakten högst i `onDiscover` (`if (resolved) return;`) står kvar: den skyddar mot att en discover-handler startar efter att scan-timeouten redan svarat.
