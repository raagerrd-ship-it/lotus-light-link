

## SSOT för tickMs — en enda källa

### Problem
`tickMs = 125` finns hårdkodat på 4 ställen. Vi vill ha **1 källa**.

### Lösning

**SSOT: `LightEngine`-klassen.** Den äger tick-loopen, så den bör äga värdet. Index.tsx skickar önskat värde via `setTickMs()` eller constructor-parameter.

### Ändringar

**1. `src/lib/engine/lightEngine.ts`**
- Ändra default: `private tickMs = 100`
- Exportera konstanten: `export const DEFAULT_TICK_MS = 100`
- `start()` skickar `this.tickMs` till workern — redan så idag

**2. `src/pages/Index.tsx`**
- Importera `DEFAULT_TICK_MS` från engine
- Ersätt `const tickMs = 125` → `const tickMs = DEFAULT_TICK_MS`

**3. `src/components/MicPanel.tsx`**
- Importera `DEFAULT_TICK_MS`
- Prop default: `tickMs = DEFAULT_TICK_MS` istället för hårdkodat `125`

**4. `public/tick-worker.js`**
- Ändra till `let currentMs = null`
- Vid `'start'`: om `currentMs` är null, gör ingenting (vänta på siffra)
- Workern startar bara när engine skickar det faktiska värdet

### Resultat
Ett enda ställe att ändra tick-hastigheten: `DEFAULT_TICK_MS` i `lightEngine.ts`. Workern har inget eget default utan lyder engine. UI-lagret importerar konstanten.

