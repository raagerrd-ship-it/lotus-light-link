

## Problem

`sendToBLE` pre-multiplies brightness into RGB, then `_flush` still contains dead-code paths for a separate brightness packet (the `_pendingBright` branch, the 1ms delay, the brightness buffer). This is unnecessary complexity since we only ever send one color packet.

## Fix

**`src/lib/bledom.ts`** — Simplify to only handle color. Remove all brightness-packet logic from `_flush` since `_pendingBright` is always null:

1. **`_flush`**: Remove `writeBright` variable, the `_pendingBright` check, the 1ms delay, and the brightness write block. Just write `_pendingColor` and done.

2. **Remove `_pendingBright`** variable entirely, and `_brightBuf` pre-allocated buffer. Remove `_lastSentBright` tracking.

3. **`sendToBLE`**: Already correct — keep pre-multiply + `_pendingColor` only. Remove the now-unnecessary `_pendingBright = null` comment line.

4. **`clearActiveChar`**: Remove `_pendingBright = null`.

5. **`setActiveChar`**: Remove `_lastSentBright = -1`.

6. **`getBleWriteStats`** / **`_flush` callback**: Adjust `_onWriteCallback` call — `sentBright` no longer tracked internally, pass the value from the last `sendToBLE` call instead (store it in a simple `_lastBright` for the callback).

Result: `_flush` becomes ~15 lines shorter, one fewer pre-allocated buffer, one fewer state variable, zero dead code paths. Single color packet per tick, nothing else.

