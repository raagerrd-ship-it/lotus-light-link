---
name: alsa-capture måste byggas med Python <3.12 på Pi
description: Native alsa-capture-bygget kräver Python 3.11 eller äldre eftersom node-gyp 9.x importerar borttagna distutils. Default Python 3.13 på Bookworm kraschar bygget tyst och engine faller tillbaka på arecord.
type: constraint
---
**Symptom:** Engine-loggen visar `Native alsa-capture unavailable: Cannot find module './build/Release/capture'` (eller `Cannot find package 'alsa-capture'`) och faller tillbaka på `node-record-lpcm16` (arecord-subprocess) → högre latens, mer CPU. `npm install alsa-capture` rapporterar `added N packages` utan synligt fel, men `node_modules/alsa-capture/build/Release/capture.node` skapas aldrig.

**Rotorsak (4 lager):**
1. `alsa-capture` är `optionalDependency` i `pi/package.json` — npm hoppar över bygget TYST om det failar
2. Release-pipelinen körs utan `libasound2-dev` (eller med fel pythonversion) → bygget failar tyst där → paketet hamnar inte i `dist.tar.gz`
3. `setup-lotus.sh` kör `npm prune --omit=dev` som tar bort optional deps som inte är ordinarie deps
4. **HUVUDPROBLEM 2026-04-19:** alsa-capture@0.3.0 använder gammal node-gyp 9.x som importerar `from distutils.version import StrictVersion`. `distutils` är BORTTAGEN i Python 3.12+. Default `python3` på Debian Bookworm/13 är 3.13 → `gyp_main.py` kraschar med `ModuleNotFoundError: No module named 'distutils'` → ingen `capture.node` byggs → modul-resolve failar i runtime.

**Lösning (build 2026-04-19/native-alsa-capture-py311):**
- Installera `python3.11 python3.11-dev python3.11-distutils` via apt (graceful fallback om paketen saknas i ditt repo)
- Auto-detect en python <3.12 (`python3.11` → `python3.10` → `python3.9`) i `setup-lotus.sh`
- Exportera `PYTHON=$GYP_PYTHON` + `npm_config_python` + `npm config set python` innan `npm install alsa-capture`
- Verifiera att `node_modules/alsa-capture/build/Release/capture.node` faktiskt skapas; om inte, kör manuell `node-gyp rebuild` i samma env

**Manuell verifiering på Pi:n:**
```bash
cd /opt/lotus-light/pi
PYTHON=$(command -v python3.11) sudo -u pi npm install alsa-capture@^0.3.0 --no-audit --no-fund
ls node_modules/alsa-capture/build/Release/capture.node && echo "✓ native byggd"
sudo systemctl restart lotus-light-engine
```

**Alternativ som INTE fungerar:**
- `--build-from-source` — npm 11+ varnar `Unknown cli config "--build-from-source"` och flaggan ignoreras
- Flytta till `dependencies` — paketet saknas fortfarande efter `npm prune --omit=dev`
- `npm rebuild alsa-capture` — kräver att paketet redan finns och bygger med samma fel python
- Bygga med `python3` (system default) på Bookworm — kraschar på distutils-importen
