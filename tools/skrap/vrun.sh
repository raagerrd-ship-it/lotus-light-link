#!/usr/bin/env bash
# vrun.sh <variantkatalog under wt/pi/_var> -> agare-rader for tickInner/onAudioData m.fl. ur replay-profil (120 s efter 150 s)
S=$(cd "$(dirname "$0")/.." && pwd); H=$S/harness; V=$1
node $H/engineReplay.mjs $(cygpath -m $S/wt/pi/_var/$V) $(cygpath -m $S/replay/$V.heapprofile) --profile ${PSECS:-60} --warm ${PWARM:-150} > /dev/null
node $H/profTop.mjs $S/replay/$V.heapprofile ${PSECS:-60} --top 12 | sed -n '1p;/per agare/,/per allok/p' | grep -v "per allok"
