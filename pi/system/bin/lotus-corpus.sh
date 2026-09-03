#!/bin/bash
# HELA LATAR. Ett 40-sekundersklipp duger till TEMPO men inte till STRUKTUR --
# klippet AR introt, och modellen svarar da helt riktigt "intro/intro" (uppmatt).
# Sektioner, taktettor och drops kraver hela laten.
#
# Sonos ger durationMs, sa langden ar kand. Vi spelar in fran latens borjan till
# dess slut, med tak pa 7 min (motorns buffert).
API=http://127.0.0.1:3051/api
DIR=/home/pi/corpus
MAXN=400
MAXSEC=415
mkdir -p $DIR
MAN=$DIR/manifest.tsv
[ -f "$MAN" ] || printf 'n\tartist\ttitle\tbpm_start\tbpm_end\tfile\tseconds\toffset_ms\n' > "$MAN"

now() { curl -s --max-time 4 $API/status 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except: raise SystemExit
def one(o,k):
    if isinstance(o,dict):
        if k in o: return o[k]
        for v in o.values():
            r=one(v,k)
            if r is not None: return r
a=one(d,'artistName') or ''; t=one(d,'trackName') or ''
b=one(d,'bpm') or 0; dur=one(d,'durationMs') or 0; pos=one(d,'positionMs') or 0
print('%s\t%s\t%s\t%s\t%s' % (a,t,round(float(b)),int(dur or 0),int(pos or 0)))
" 2>/dev/null; }

slug() { echo "$1" | tr 'A-ZÅÄÖåäö' 'a-zaaoaao' | sed 's/[^a-z0-9]\+/-/g;s/^-\+\|-\+$//g' | cut -c1-58; }

prev=""
n=$(( $(wc -l < "$MAN") - 1 ))
while [ $n -lt $MAXN ]; do
  cur=$(now)
  [ -z "$cur" ] && { sleep 5; continue; }
  key=$(echo "$cur" | cut -f1,2)
  if [ -n "$prev" ] && [ "$key" != "$prev" ] && [ -n "$(echo "$key" | tr -d '\t')" ]; then
    a=$(echo "$cur" | cut -f1); t=$(echo "$cur" | cut -f2); b0=$(echo "$cur" | cut -f3)
    dur=$(echo "$cur" | cut -f4); pos=$(echo "$cur" | cut -f5)
    # Kvar av laten = langd minus dar vi ar nu (bytet upptacks nagra sekunder in).
    left=$(( (dur - pos) / 1000 ))
    [ "$left" -lt 30 ] && { prev="$key"; sleep 4; continue; }   # for kort rest: hoppa
    [ "$left" -gt $MAXSEC ] && left=$MAXSEC
    # REGLAGET "Spela in". Fragas har och inte vid start, sa det gar att sla av
    # mitt i en spellista utan att starta om nagon tjanst. Svarar motorn inte
    # alls spelar vi in — att tappa en inspelning ar varre an en for mycket.
    rec=$(curl -s --max-time 3 $API/toggles 2>/dev/null | sed -n "s/^recordEnabled=//p")
    if [ "$rec" = "0" ]; then prev="$key"; sleep 4; continue; fi
    n=$((n+1))
    f=$(printf '%03d' $n)_$(slug "$a-$t").wav
    # LATPOSITIONEN KOMMER FRAN SVARET, inte fran var egen lasning.
    #
    # Forr anvandes `pos` som lastes har ovanfor -- alltsa INNAN inspelningen ens
    # bad om att fa borja, och plockad med en generisk sokning genom statusen som
    # lika garna hittar Sonos nedrundade sekundvarde som latklockans exakta.
    # Bada felen gor offseten for LITEN, och da pastar hela den lagrade
    # tidslinjen att allt hander tidigare an det gor. Showen gick FORE musiken:
    # uppmatt 500-1700 ms, olika for varje inspelning.
    #
    # Motorn ager bade micen och klockan och svarar nu med var i laten det
    # forsta samplet faktiskt togs.
    startpos=$(curl -s --max-time 5 -X POST $API/raw-capture/start \
      -H "Content-Type: application/json" \
      -d "{\"seconds\":$left,\"label\":\"$a - $t\"}" \
      | sed -n 's/.*\"positionMs\":*\([0-9-]*\).*/\1/p')
    # Klockan kan sakna las de forsta sekunderna av en lat; da far den gamla
    # lasningen duga hellre an ingen alls.
    [ -n "$startpos" ] && pos=$startpos
    sleep $((left + 5))
    if curl -s --max-time 300 -o "$DIR/$f" $API/raw-capture/wav && [ -s "$DIR/$f" ]; then
      b1=$(now | cut -f3)
      printf '%d\t%s\t%s\t%s\t%s\t%s\t%d\t%d\n' "$n" "$a" "$t" "$b0" "$b1" "$f" "$left" "$pos" >> "$MAN"
    else
      rm -f "$DIR/$f"; n=$((n-1))
    fi
  fi
  [ -n "$(echo "$key" | tr -d '\t')" ] && prev="$key"
  sleep 4
done
echo "korpus full: $n spar"
