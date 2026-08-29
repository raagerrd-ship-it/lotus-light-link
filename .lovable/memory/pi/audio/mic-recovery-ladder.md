---
name: Mic-återställning — spegling av spi_recovery.py
description: I2S-wedge löses med unbind/bind av bcm2835-i2s via /usr/local/sbin/lotus-i2s-rebind + smal sudoers-regel, sedan MÅSTE processen dö. Stegen 2 ombindningar → 2 reboots → ge upp (idle-färg).
type: feature
---
**FIX 15 (v1.0.789).** Byggd som direkt spegling av brew-control/`spi_rebind.sh` +
`spi_recovery.py` — samma klass av problem (fastlåst hårdvarubuss), beprövat mönster.

- `pi/scripts/i2s_rebind.sh` → installeras som `/usr/local/sbin/lotus-i2s-rebind`
  (root, 0755) av både `setup-lotus.sh` och `update-services.sh`. Enheten slås upp
  ur `/sys/class/sound/card0/device`, inte hårdkodad adress. Ljudstacken modprobas
  om efter bind; saknas `/dev/snd/pcmC0D0c` → exit 1 (anroparens nästa steg är reboot).
- Sudoers: `/etc/sudoers.d/lotus-i2s-rebind` ger NOPASSWD BARA för det skriptet och
  `/sbin/reboot`. Aldrig `tee` eller `sh -c` — det lämnar över hela filsystemet.
- `pi/src/micRecovery.ts`: försökslogg i `PCC_DATA_DIR/mic-recovery.json`, åtgärder
  räknas separat (`MAX_REBINDS=2`, `MAX_REBOOTS=2`, `GIVE_UP_WINDOW_S=3600`).
  `clearMicRecovery()` efter 60 s frisk mic.
- **Processen MÅSTE dö efter ombindning** (`process.exit(1)`, SIGKILL efter 2 s om
  native tråden blockerar): den håller handtag på GAMLA styrenheten. En intern
  `restartCapture()` räcker ALDRIG efter en ombindning — uppmätt live 2026-08-29.
- Ge upp → `engine.setMicSafeMode(true)`: lampan låses på idle-färg, `tickInner`
  returnerar direkt (ingen pulsning på fruset underlag), kritisk logg.
- Detektor: befintlig byte-identisk + nästan-konstant-RMS vakt PLUS nytt villkor —
  `wdb` rör sig <0.5 dB på 20 s medan Sonos rapporterar PLAYING. Det fångade
  samtliga observerade fall där `micContentFrozenMs` var 0 men micen var död.
