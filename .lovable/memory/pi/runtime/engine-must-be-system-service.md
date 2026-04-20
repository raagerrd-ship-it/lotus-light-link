---
name: Engine MÅSTE köras som system-service med audio+netdev+bluetooth
description: PCC skapar lotus-light-engine som --user-service som inte ärver supplementary groups. setup-lotus.sh skriver över med system-service som har SupplementaryGroups=netdev bluetooth audio (audio krävs för ALSA mic-capture, annars EACCES).
type: constraint
---
**Symptom utan audio-grupp:** mic-subsystem startar ("ready") men `onAudioData`-callbacken triggas aldrig → fftPerSec=0, ingen ljus-respons. ALSA `snd_pcm_open` failar tyst i native binding utan audio-grupp.

**Symptom utan netdev:** `rfkill: cannot open /dev/rfkill: Permission denied`, noble fastnar i state=unknown.

**Lösning (setup-lotus.sh):**
1. `SupplementaryGroups=netdev bluetooth audio` i unit-filen
2. `usermod -aG netdev bluetooth audio pi` (permanent system-grupp överlever cap-clear)
3. system-service, INTE user-service (user-services kan inte sätta SupplementaryGroups)

**Verifiera:**
```bash
sudo systemctl cat lotus-light-engine | grep Supplementary
# Förväntat: SupplementaryGroups=netdev bluetooth audio
sudo journalctl -u lotus-light-engine | grep "Boot/Perms.*groups:"
# Förväntat: groups innehåller audio, netdev, bluetooth
```

**update-services.sh** har health-check som tvingar full re-deploy om audio saknas.
