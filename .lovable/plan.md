

## Problem

Varje gång sidan laddas måste du manuellt trycka på en knapp och välja enhet. Återanslutningen borde ske automatiskt.

## Plan

### 1. Auto-reconnect vid sidladdning (`src/pages/Index.tsx`)
- Lägg till en `useEffect` som körs vid mount och automatiskt anropar `reconnectLastDevice()` om det finns en sparad enhet i localStorage.
- Visa en laddningsindikator ("Ansluter till [enhetsnamn]...") medan det pågår.
- Om auto-reconnect misslyckas, visa anslutningsknapparna som vanligt (tyst fallback, inget felmeddelande).

### 2. Auto-reconnect vid frånkoppling (`src/pages/Index.tsx`)
- I `gattserverdisconnected`-lyssnaren: istället för att bara nollställa connection, försök automatiskt återansluta med en kort fördröjning (2 sek). Visa "Återansluter..." i UI:t.
- Max 3 försök, sedan fallback till manuell anslutningsskärm.

### 3. Längre timeout för advertisement-scanning (`src/lib/bledom.ts`)
- Öka advertisement-timeout från 5s till 8s för bättre chans att hitta enheten.

### Sammanfattning
- Sidan försöker automatiskt ansluta till senast använda enhet direkt vid laddning
- Vid tappad anslutning försöker den återansluta automatiskt upp till 3 gånger
- Användaren behöver bara manuellt välja enhet första gången

