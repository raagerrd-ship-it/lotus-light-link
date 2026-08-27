---
name: base-denoise
description: Kort input-EMA på ljus-signalen före dB-mappning avbrusar basnivån utan att sakta beat-attacken
type: feature
---
# Lotus-light — FIX 5: avbrusa basnivån

Problem: ljuset rör sig ryckigt pga frame-till-frame-brus i basnivån, inte pga beat-pulser (jitter ≈ 0 korrelerat med onset).

Lösning: kort input-EMA på den frekvensviktade ljus-signalen (`wlevel`) FÖRE dB-mappningen i `piEngine.tickInner`.

- Tidskonstant: `cal.lightSmoothMs` (default 35 ms).
- EMA-alfa: `aSm = 1 - Math.exp(-FRAME_MS / lightSmoothMs)`.
- Beat-punchen (fluxBoost/onset) adderas EFTER mappningen och är oberörd.
- `attackAlpha` förblir 1.0 (snabb attack) — smidigheten kommer från input-EMA:n, inte från att bromsa attacken.

Nollställning: `this._wlevelSm = undefined` vid:
- `initOnsetBuffer()`
- `setPlaying(false)`
- `onBleConnected()` i active-läge
- `sanitizeState()`

DEFAULT_CAL-uppdateringar:
- `flickerDeadband: 0.045`
- `anchorDb: -4`
- `windowDb: 22`
- `brightnessFloor: 15`
- `attackAlpha: 1.0`
- `releaseAlpha: 0.4`
- `lightSmoothMs: 35`

Live-tuning: `lightSmoothMs` är en kalibreringsparameter och kan justeras via `/api/calibration` (PUT). 20 ms = knappt märkbart, 50–60 ms = tydligt lugnare bas.
