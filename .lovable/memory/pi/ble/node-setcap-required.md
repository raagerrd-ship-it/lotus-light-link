---
name: Node-binären kräver setcap för noble HCI-access
description: @stoprocent/noble plockar inte upp systemd AmbientCapabilities — file capabilities måste sättas direkt på /usr/bin/node, annars fastnar state på "unknown".
type: feature
---
**Problem:** Med systemd-tjänsten (`AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN` + `NoNewPrivileges=false`) fastnar `noble.state` på `"unknown"` även när:
- `hciconfig hci0` visar `UP RUNNING`
- `rfkill` är ej blockerad
- `/proc/$PID/status` visar att tjänsten har CapEff med CAP_NET_RAW

**Verifierat:** Med `sudo node -e "..."` (root → alla caps) fungerar noble perfekt — `[stateChange] poweredOn` direkt och hundratals discover-events strömmar in (inkl. ELK-BLEDOM01).

**Lösning:** Sätt file capabilities direkt på node-binären i setup-lotus.sh:
```bash
NODE_BIN="$(readlink -f "$(command -v node)")"
sudo setcap 'cap_net_raw,cap_net_admin+eip' "$NODE_BIN"
```

Verifiera: `getcap $(readlink -f $(which node))` → `cap_net_admin,cap_net_raw=eip`

**Varför:** Node.js native bindings (HCI raw socket via `@stoprocent/noble`) öppnar socket innan systemd's ambient caps appliceras på child-processen, eller så plockar bindingen inte upp dem alls. File caps på själva binären är robust och fungerar oavsett process-tree.

**Ordning som spelar roll i setup-lotus.sh:**
1. Installera Node 24 via apt
2. `setcap` på `$(readlink -f $(which node))` (efter Node-install, FÖRE service-restart)
3. `systemctl --user restart lotus-light-engine`

Vid Node-uppgradering måste setcap köras igen — apt skriver över binären och tappar caps.
