

## Plan: Slå ihop `_flush` i `sendToBLE`

### Analys

Tick-workern (125ms intervall) garanterar redan att:
- Anrop sker sekventiellt — `_writing`-flaggan är onödig
- Intervallet > BLE-skrivtid (~8-15ms) — backoff behövs inte
- En färg per tick — ingen kö, inget att droppa

`_flush` kan elimineras helt.

### Ändringar

**`src/lib/bledom.ts`:**
- Ta bort `_flush`, `_writing`, `_backoffUntil`, `_pendingColor`
- Gör `sendToBLE` async och låt den skriva direkt:

```typescript
export async function sendToBLE(r: number, g: number, b: number, brightness: number) {
  if (!_char) return;
  const scale = Math.max(0, Math.min(100, brightness)) / 100;
  _colorBuf[4] = Math.round(r * scale);
  _colorBuf[5] = Math.round(g * scale);
  _colorBuf[6] = Math.round(b * scale);
  _lastBright = brightness;

  const t0 = performance.now();
  try {
    await _char.writeValueWithoutResponse(_colorBuf);
    _writeCount++;
    _lastWriteMs = performance.now() - t0;
    _onWriteCallback?.(_lastBright, _colorBuf[4], _colorBuf[5], _colorBuf[6]);
  } catch (e: any) {
    console.warn('[BLE] write error:', e?.message);
  }
}
```

**`src/components/MicPanel.tsx`** (eller där `sendToBLE` anropas):
- Lägg till `await` framför `sendToBLE`-anropet i tick-hanteraren (om det inte redan awaitas)

### Resultat
~20 rader borttagna, en funktion mindre, noll beteendeförändring.

