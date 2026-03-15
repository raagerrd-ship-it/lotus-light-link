

## Problem

The sun's JSX (line 748-749) sets `background` and `boxShadow` using React state color (`r,g,b` from `currentColor`). Every time React re-renders (which happens frequently at 40fps due to state updates), the JSX-rendered style briefly overwrites the smooth rAF-driven values — causing visible flicker.

The rAF loop (lines 311-332) already handles sun color and glow correctly using refs, so the JSX initial values are fighting it.

## Fix

**`src/components/MicPanel.tsx`** — Remove color from the sun's initial JSX style. Set neutral/transparent defaults and let the rAF loop exclusively own the `background` and `boxShadow` properties:

```tsx
style={{
  width: '55vw',
  height: '55vw',
  maxWidth: '55vh',
  maxHeight: '55vh',
  transform: 'scale(1)',
  willChange: 'transform, box-shadow, background',
  background: 'transparent',
  boxShadow: 'none',
}}
```

The rAF loop already sets these on every frame via direct DOM manipulation — removing the React-driven values eliminates the flickering entirely. There may be a brief flash of no glow on first mount before the first rAF frame fires, but that's imperceptible.

