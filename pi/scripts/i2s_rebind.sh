#!/bin/sh
# Re-initialise the I2S controller in place, without rebooting.
#
# When the capture stream wedges, ALSA still reports RUNNING and hw_ptr keeps
# advancing — but every period contains the same word. That is a statement about
# the *controller/DMA*, not the microphone: a silent INMP441 would still be
# clocked and return dither noise. That is why reopening hw:0,0 has never helped,
# and why until now only a power cycle did.
#
# Spegling av brew-control/spi_rebind.sh — samma klass av problem, samma mönster.
# Installeras som /usr/local/sbin/lotus-i2s-rebind med EN smal sudoers-regel för
# just detta skript. En NOPASSWD-regel för `tee` eller `sh -c` lämnar över hela
# filsystemet.
set -eu

DRV=/sys/bus/platform/drivers/bcm2835-i2s
FALLBACK=3f203000.i2s

# Slå upp enheten ur sysfs i stället för att lita på adressen: den är stabil
# idag, men en kernel- eller overlay-ändring skulle tyst göra skriptet till en
# no-op som ändå returnerar 0.
if [ -e /sys/class/sound/card0/device ]; then
    DEV=$(basename "$(readlink -f /sys/class/sound/card0/device)")
else
    DEV=$FALLBACK
fi

if [ ! -e "$DRV/bind" ]; then
    echo "i2s-rebind: $DRV saknas — fel drivrutin?" >&2
    exit 2
fi

[ -e "$DRV/$DEV" ] && echo "$DEV" > "$DRV/unbind"
sleep 1
echo "$DEV" > "$DRV/bind"
sleep 1

# Ljudstacken måste laddas om efter bind, annars kommer kortet inte tillbaka.
modprobe -r snd_soc_rpi_simple_soundcard snd_soc_googlevoicehat_codec snd_soc_bcm2835_i2s 2>/dev/null || true
sleep 1
modprobe snd_soc_bcm2835_i2s snd_soc_googlevoicehat_codec snd_soc_rpi_simple_soundcard 2>/dev/null || true
sleep 2

# Rapportera misslyckande i stället för att låta anroparen tro att bussen är
# tillbaka: anroparens nästa steg är en reboot, och det får inte hoppas över.
if [ ! -e /dev/snd/pcmC0D0c ]; then
    echo "i2s-rebind: /dev/snd/pcmC0D0c kom inte tillbaka" >&2
    exit 1
fi

echo "i2s-rebind: $DEV ombunden"
