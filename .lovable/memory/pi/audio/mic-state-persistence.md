---
name: Mic-state persisteras över restart
description: autoGainEnabled, micGainBase och kalibreringspunkter (calPoint1/calPoint2) sparas i DATA_DIR/mic-state.json via storage-shim. Restoreas vid modulinit i alsaMic.ts. Krasch/restart mitt i låt → samma inställningar som innan.
type: feature
---
**Bug innan fix:** alla tre värdena var bara `let` i `pi/src/alsaMic.ts` → defaultade till `false`/`15.0`/`null` vid varje processtart. Användaren upplevde det som "tappade autogain mitt i låten" och misstänkte auto-update (som dock är avstängd, se manual-update-only.md).

**Implementation (`pi/src/alsaMic.ts`):**
- `MIC_STATE_KEY = 'mic-state'` → DATA_DIR/mic-state.json
- `saveMicState()` anropas i `setMicGain`, `setGainCalPoints`, `enableAutoGain`, `disableAutoGain`
- IIFE `restoreMicState()` körs vid modulinit, läser via `storage.getItem`
- Defensiv parsning: typkontroll på varje fält innan tilldelning

**Inte persisterat (medvetet):**
- `micGainAuto` — alltid härledd från cal-punkter + senaste Sonos-vol
- `lastSonosVol` — fylls inom sekunder av sonosPoller efter restart
- `currentDevice` / `currentFormat` — styrs av env/config

Verifierat 2026-04-26.
