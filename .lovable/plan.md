

## Fix: piBase ska använda aktuell port (inte hårdkodad 3050)

**Problem:** `piBase` på rad 634-637 i `PiMobile.tsx` pekar fortfarande på port 3050 (engine-porten). UI:t servas av `frontend.ts` på en valbar port (default 3001), som proxar `/api/*` till motorn på 3050. UI:t ska prata med frontend-servern, inte direkt med motorn.

**Ändring i `src/pages/PiMobile.tsx` (rad 634-637):**

```typescript
// Nuvarande (fel):
const piBase = typeof window !== 'undefined'
  ? `http://${window.location.hostname}:3050`
  : 'http://localhost:3050';

// Nytt (korrekt):
const piBase = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:3001';
```

`window.location.origin` ger `http://hostname:port` — exakt den port användaren surfar på. Frontendservern proxar sedan `/api/*` vidare till motorn på 3050.

En rad att ändra, inga andra filer påverkas.

