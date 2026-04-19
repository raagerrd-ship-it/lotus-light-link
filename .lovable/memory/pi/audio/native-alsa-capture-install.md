---
name: alsa-capture måste installeras explicit på Pi:n
description: Native alsa-capture är optionalDependency som failar på release-runner (saknad libasound2-dev) och prunas bort i dist. setup-lotus.sh måste npm install den separat efter prune.
type: constraint
---
**Symptom:** Engine-loggen visar `Native alsa-capture unavailable: Cannot find package 'alsa-capture'` och faller tillbaka på `node-record-lpcm16` (arecord-subprocess) → högre latens, mer CPU.

**Rotorsak (3 lager):**
1. `alsa-capture` är `optionalDependency` i `pi/package.json` — npm hoppar över den TYST om bygget failar
2. Release-pipelinen bygger på GitHub Actions ARM64-runner som saknar `libasound2-dev` → bygget failar tyst där → paketet hamnar inte i `dist.tar.gz`
3. `setup-lotus.sh` kör `npm prune --omit=dev` som dessutom tar bort optional deps som inte är ordinarie deps

**Lösning (build 2026-04-19/native-alsa-capture-explicit):**
- Lägg till `build-essential python3 python3-dev` i apt-installen (krävs av node-gyp)
- EFTER `npm prune`, kör `npm install alsa-capture@^0.3.0 --build-from-source` explicit
- Bekräfta efter release: loggen ska visa `[ALSA] Using native alsa-capture (direct snd_pcm_readi)`

**Alternativ som INTE fungerar:**
- Flytta till `dependencies` — npm rebuild på en x64-runner failar fortfarande tyst
- `npm rebuild alsa-capture` — kräver att paketet redan finns i node_modules, vilket det inte gör efter dist-extract från release
