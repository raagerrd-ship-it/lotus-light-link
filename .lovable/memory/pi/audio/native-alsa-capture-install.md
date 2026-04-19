---
name: alsa-capture måste byggas med node-gyp 10+ på modern Debian
description: Native alsa-capture-bygget kräver node-gyp 10+ när Python är 3.12 eller nyare (Bookworm/Trixie default). Bundlade node-gyp 9.x importerar borttagna distutils.
type: constraint
---
**Symptom:** Engine-loggen visar `Native alsa-capture unavailable: Cannot find module './build/Release/capture'` och faller tillbaka på `node-record-lpcm16` (arecord-subprocess) → högre latens, mer CPU. `npm install alsa-capture` rapporterar `added N packages` utan synligt fel, men `node_modules/alsa-capture/build/Release/capture.node` skapas aldrig.

**Rotorsak (4 lager):**
1. `alsa-capture` är `optionalDependency` i `pi/package.json` — npm hoppar över bygget TYST om det failar
2. Release-pipelinen körs utan `libasound2-dev` (eller med fel pythonversion) → bygget failar tyst där → paketet hamnar inte i `dist.tar.gz`
3. `setup-lotus.sh` kör `npm prune --omit=dev` som tar bort optional deps som inte är ordinarie deps
4. **HUVUDPROBLEM 2026-04-19:** alsa-capture@0.3.0 levereras med node-gyp 9.x som importerar `from distutils.version import StrictVersion`. `distutils` är BORTTAGEN i Python 3.12+. Default `python3` på Debian Bookworm är 3.12 och Trixie/13 är 3.13 → `gyp_main.py` kraschar med `ModuleNotFoundError: No module named 'distutils'` → ingen `capture.node` byggs.

**Lösning (build 2026-04-19/native-alsa-capture-nodegyp10):**
- Installera **node-gyp 10+ globalt** med `npm install -g node-gyp@^10` — denna version använder `packaging.version.parse` istället för `distutils.version.StrictVersion` och fungerar med Python 3.13
- Exportera `npm_config_node_gyp=$(command -v node-gyp)` så `npm install alsa-capture` använder den globala gypen istället för paketets bundlade 9.x
- Backup: om `python3.11` finns i apt så installera och peka via `PYTHON` + `npm_config_python` (extra säkerhet, ej krav)
- Verifiera att `node_modules/alsa-capture/build/Release/capture.node` faktiskt skapas; om inte, kör manuell `node-gyp rebuild` med global gyp

**python3.11 finns inte i alla repon:**
- Debian Trixie (13) och Raspberry Pi OS baserat på Trixie levererar bara python3.13 — python3.11 saknas i officiella repon
- Att lägga till deadsnakes PPA fungerar bara på Ubuntu, inte Debian/Pi OS
- Att bygga Python från källkod tar ~30 min på Pi Zero 2W → undvik
- Lösningen: använd node-gyp 10+ med systemets python3.13 (rekommenderad väg)

**Manuell verifiering på Pi:n:**
```bash
sudo npm install -g node-gyp@^10
cd /opt/lotus-light/pi
sudo rm -rf node_modules/alsa-capture
sudo -u pi npm_config_node_gyp=$(command -v node-gyp) npm install alsa-capture@^0.3.0 --no-audit --no-fund
ls node_modules/alsa-capture/build/Release/capture.node && echo "✓ native byggd"
sudo systemctl restart lotus-light-engine
```

**Alternativ som INTE fungerar:**
- `--build-from-source` — npm 11+ varnar `Unknown cli config "--build-from-source"` och flaggan ignoreras
- Flytta till `dependencies` — paketet saknas fortfarande efter `npm prune --omit=dev`
- `npm rebuild alsa-capture` utan global node-gyp 10+ — använder paketets bundlade 9.x
- Bygga med `python3` (3.13) utan node-gyp 10+ — kraschar på distutils-importen
- deadsnakes PPA — finns inte för Debian/Pi OS, bara Ubuntu
