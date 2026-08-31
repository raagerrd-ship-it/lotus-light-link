---
name: Mic-uppvaknande från idle kräver isMicActive()-grind
description: startMicSubsystem får inte returnera enbart på subsystem-status 'ready' — statusen lämnar aldrig ready (ingen markSubsystemIdle finns) medan stopMic() satt capture=null → 45–60 s mörk lampa efter paus.
type: constraint
---
`if (getSubsystemState('mic').status === 'ready') return;` gjorde uppvaknandet till en no-op:
`stopMic()` vid idle sätter `capture = null`, men statusen står kvar på `'ready'` för alltid.
Både `isMicStalled()` och `restartCapture()` börjar med `if (!capture) return false` → detektorn
blind, omstartaren vägrar (noll `restartCapture (playback-watchdog)`-rader trots sex loggade soft
recoveries).

Rätt grind: `status === 'ready' && alsaMic?.isMicActive?.() !== false` (`isMicActive()` = `capture !== null`).

Privilegierade åtgärder: motorn kan ALDRIG köra sudo (`CapabilityBoundingSet` saknar CAP_SETUID/SETGID).
`micRecovery.ts` skriver `DATA_DIR/i2s-rebind.req` → `lotus-i2s-rebind.path`/`.service` (root startar om
motorn EFTER ombindningen). Misslyckad begäran får INTE räknas som försök — låtsas-försök gav
`gaveUp` → lampan parkerad i idle-färg permanent.
