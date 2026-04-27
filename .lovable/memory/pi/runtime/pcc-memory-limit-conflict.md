---
name: PCC memory limit conflicts
description: PCC tvångssätter låg MemoryMax (96MB) på lotus-light-engine via drop-in 50-MemoryMax.conf, vilket orsakar cgroup-OOM kills som ser ut som clean shutdowns. Lösning kräver höjd gräns i services.json + override drop-in 99-node-heap.conf.
type: constraint
---

PCC sätter `MemoryMax=96M` på `lotus-light-engine` via drop-in `/etc/systemd/system.control/lotus-light-engine.service.d/50-MemoryMax.conf` baserat på sin "balanced/low"-profil. Den genererade unit-filen har också hårdkodat `--max-old-space-size=96` i ExecStart.

**Symptom:** Engine "Stoppas" var 30:e min till 5h utan synliga krasch-meddelanden. Loggen visar bara `Stopping` → `Deactivated successfully` (cgroup-OOM ser ut som clean SIGTERM). `dmesg` visar inget eftersom det är cgroup-OOM, inte system-OOM.

**Korrekt minnesbudget på Pi Zero 2W (416 MB RAM + 415 MB swap):**
- MemoryMax: 320 MB
- MemoryHigh: 240 MB (mjukt tryck → GC hinner reagera)
- Node `--max-old-space-size`: 224 MB

**Fix på Pi:n direkt (träder i kraft tills PCC åter-skriver):**
```bash
sudo systemctl revert lotus-light-engine
sudo systemctl set-property lotus-light-engine MemoryMax=320M MemoryHigh=240M
sudo tee /etc/systemd/system/lotus-light-engine.service.d/99-node-heap.conf >/dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/node --max-old-space-size=224 /opt/lotus-light/pi/dist/index.js
Environment=NODE_OPTIONS=
EOF
sudo systemctl daemon-reload && sudo systemctl restart lotus-light-engine
```

**Permanent fix i repo:** `pi/services.json` har `components.engine.resources.memoryMax: "320M"` + `nodeOptions: "--max-old-space-size=224"`. Beror på att PCC läser dessa fält — om inte måste setup-lotus.sh skriva drop-in `99-node-heap.conf` direkt vid install/update.

**Varning:** PCC kan ändå tvångssätta sin egen `50-MemoryMax.conf` periodiskt — kontrollera att vår `99-*.conf` har högre prioritet (99 > 50, så den vinner ExecStart-overriden, men `set-property` skapar `50-MemoryMax.conf` i `system.control/` vilket tar prioritet över `system/`). Lösning: re-revert + re-apply i en boot-time script eller PCC-konfig.
