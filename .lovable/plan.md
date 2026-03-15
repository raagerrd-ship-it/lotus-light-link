

## Problem

In `src/pages/Index.tsx` lines 186-192, `handleLiveStatus` computes a pre-multiplied color and sets that as `bleSentColor`. The debug overlay then shows the already-mixed result instead of the pure color + brightness separately.

The `onBleWrite` callback in `bledom.ts` (line 317) already fires with the **original** (pre-multiply) values: `_onWriteCallback(brightness, r, g, b)`. These flow through MicPanel's `onLiveStatus` correctly as `bleSentColor: [r, g, b]` and `bleSentBright: bright`. The corruption happens only in `Index.tsx`.

## Fix

**`src/pages/Index.tsx`** — Remove the pre-multiplication in `handleLiveStatus`. Just pass the values through directly:

```tsx
// Lines 184-193: Replace with simple pass-through
if (status.bleSentColor) {
  setBleBaseColor(status.bleSentColor);
  setBleSentColor(status.bleSentColor); // Pure color, no pre-multiplication
}
```

That's it. One change, 6 lines removed/simplified. The debug overlay already shows the color dot from `bleBaseColor`/`bleSentColor` and brightness from `bleSentBright` separately — which is exactly what the user wants: "this color at this brightness level" before the final mix happens in `sendToBLE`.

