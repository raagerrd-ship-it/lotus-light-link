---
name: TV-läge håller motorn igång + per-profil globaler
description: isTvMode idlar INTE längre motorn (setPlaying(playing)). Auto-gain respekterar user-override. dimmingGamma + gainCalibration ligger per profil. TV-läge auto-växlar aktiv profil till tv-profile (default Custom).
type: feature
---
**2026-08-17.**

1. **Motor-idle i TV-läge borttaget** (`pi/src/index.ts`, `onSonosPlayingChange`):
   `await fn(playing)` — tidigare `playing && !state.isTvMode`, vilket gjorde att
   `tickInner` aldrig kördes i TV-läge → statisk lampa trots `setTvSoft`.
   Idle gäller nu enbart äkta "spelar inte".

2. **Auto-gain user-override** (`pi/src/alsaMic.ts`): `autoGainUserDisabled`
   sätts av `disableAutoGain()`, rensas av `enableAutoGain()`, persisteras i
   `mic-state.json`. Sonos-volym-pathen kallar `maybeAutoEnableAutoGain()`
   (aktiverar bara om användaren inte stängt av). Aldrig `enableAutoGain()`
   direkt från volym-pathen igen.

3. **Per-profil globaler** (`pi/src/configServer.ts`): profil kan bära
   `dimmingGamma` och `gainCalibration {point1,point2}`. `applyProfileGlobals()`
   körs vid boot, `PUT /api/profiles`, `PUT /api/active-preset` och
   `setActivePresetByName()`. Saknas fältet → globalt värde lämnas orört
   (mjuk migrering). `PUT /api/dimming-gamma` och `PUT /api/gain-calibration`
   speglar in i aktiv profil.

4. **Auto-växling per läge**: `GET/PUT /api/tv-profile {name}` (default `Custom`).
   TV-läge → `setActivePresetByName(tvProfile)`, sparar föregående preset och
   återställer när TV-läget upphör (`switchToTvProfile` i index.ts).

Ej gjort (valfritt spår): "linear meter"-läge utan dold `RAW_SCALE = 5` och
dubbel gamma.
