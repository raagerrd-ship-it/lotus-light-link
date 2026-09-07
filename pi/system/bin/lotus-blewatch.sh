#!/bin/bash
# BLE-VAKTHUND. Ser till att lampan inte star mork medan ingen tittar.
#
# Sjalva boten ligger i ble-prime.sh -- se den for den uppmatta felkedjan.
DOWN_LIMIT_MS=45000
COOLDOWN=240
last=0

status() {
  curl -s --max-time 4 http://127.0.0.1:3051/api/status 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); b=d.get('ble',{})
    print('%s %s' % (b.get('connected') or 0, b.get('downForMs') or 0))
except: print('- -')
" 2>/dev/null
}

while true; do
  sleep 20
  # MOTORN NERE? STARTA DEN.
  #
  # Stod tidigare `|| continue` har — alltsa hoppa over. Det gjorde vakthunden
  # blind for det varsta som kan handa: en stoppad motor. Uppmatt intraffade det
  # nar vakthundens egen stop/prima/start-sekvens krockade med en deploy som
  # gjorde `restart` samtidigt; de tog ut varandra och motorn blev staende
  # stoppad — med slackt lampa och ingen som reste den.
  #
  # Tjansten ar enabled och ska alltid ga, sa att starta den ar ratt svar.
  if [ "$(systemctl is-active lotus-light-engine)" != "active" ]; then
    echo "[blewatch] motorn ar nere — startar" >&2
    systemctl start lotus-light-engine
    sleep 20
    continue
  fi
  set -- $(status)
  conn=$1; down=$2
  case "$conn$down" in *-*) continue;; esac
  if [ "$conn" = "0" ] && [ "${down:-0}" -gt "$DOWN_LIMIT_MS" ] 2>/dev/null; then
    now=$(date +%s)
    if [ $((now - last)) -lt $COOLDOWN ]; then continue; fi
    last=$now
    echo "[blewatch] BLE nere ${down}ms — primar lanken" >&2
    systemctl stop lotus-light-engine
    sleep 2
    if /usr/local/bin/lotus-ble-prime.sh; then echo "[blewatch] primning OK" >&2
    else echo "[blewatch] primning misslyckades — startar anda" >&2; fi
    systemctl start lotus-light-engine
  fi
done
