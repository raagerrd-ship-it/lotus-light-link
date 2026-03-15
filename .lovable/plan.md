

## MicPanel.tsx — Simplification Opportunities

**757 lines** reviewed. Here are the concrete issues found:

### 1. Identical render branches (lines 733-754)
The `isCompact` check returns **exactly the same JSX** in both branches. The entire conditional and `isCompact` variable (line 716) can be removed — just keep one return.

### 2. Unused destructure (line 731)
`const [r, g, b] = currentColor` — never referenced in the JSX. Remove it.

### 3. Dead fields in `onLiveStatus` callback
- `isWhiteKick` is **always `false`** (line 665) — vestigial from removed feature
- `quietFrames` is **always `0`** (line 678) — same

These should be removed from the callback and the `MicPanelProps` interface type.

### 4. Duplicate band AGC logic (lines 486-507)
Bass AGC and MidHi AGC are identical logic with different refs. Extract a helper:
```text
function updateBandAgc(value, maxRef, minRef, attack, decay)
```
Cuts ~20 lines to ~6.

### 5. Misleading ref name
`sunRef` (line 166) — the "sun" visualization was removed. Rename to `containerRef`.

### 6. Ref consolidation opportunity
~40 individual `useRef` calls for mutable tick state. These could be grouped into one or two mutable object refs (e.g. `agcState`, `bandState`) to reduce declaration noise. This is cosmetic but would cut ~25 lines of boilerplate.

### 7. Volume and loudness AGC rescaling share a pattern
Lines 204-216 (loudness change) and 431-445 (volume change) both do the same "ratio-scale all AGC refs" operation. A shared helper like `rescaleAllAgc(ratio)` would eliminate duplication.

---

### Summary of changes

| Change | Lines saved | Risk |
|--------|------------|------|
| Remove duplicate render branch | ~15 | None |
| Remove unused `[r,g,b]` | 1 | None |
| Remove dead `isWhiteKick`/`quietFrames` | 2+ interface | Low (update parent) |
| Extract `updateBandAgc` helper | ~14 | None |
| Extract `rescaleAllAgc` helper | ~12 | None |
| Rename `sunRef` → `containerRef` | 0 (clarity) | None |
| Group refs into objects | ~20 | Low |

**Estimated net reduction: ~60 lines**, plus cleaner readability.

