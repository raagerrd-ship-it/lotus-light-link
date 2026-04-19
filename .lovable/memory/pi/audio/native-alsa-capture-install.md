---
name: alsa-capture vendored som lokal fork pga Node 24-inkompatibilitet
description: alsa-capture@0.3.0 är övergiven (2022) och dess nan@2.17 misslyckas att kompilera mot V8 i Node 24. Lösning: vendora i pi/vendor/alsa-capture/ med nan uppgraderad till ^2.26.2.
type: constraint
---
**Symptom:** På Pi med Node 24 + Python 3.13 failar `npm install alsa-capture@^0.3.0` med två separata fel:
1. **Python**: `from distutils.version import StrictVersion` → `ModuleNotFoundError` (distutils borttaget i Python 3.12+, alsa-capture bundlar node-gyp@9 som inte stödjer det)
2. **V8**: `could not convert v8::Undefined((...)->GetIsolate()) from Local<v8::Primitive> to Local<v8::Value>` i `streaming-worker.h:221` — nan@2.17 är inkompatibel med Node 24:s skärpta V8-typer

**Rotorsak:** alsa-capture är övergiven sen 2022. Ingen kommer fixa upstream.

**Lösning (build 2026-04-19/vendored-alsa-capture):**
- Forka in upstream-källan till `pi/vendor/alsa-capture/` (capture.cc, streaming-worker.h, macros.h, binding.gyp, index.js, index.d.ts oförändrade)
- Bytt ut `package.json`: bumpa `nan` till `^2.26.2` (släppt mars 2026, har Node 24-stöd), ta bort `node-gyp` ur deps (bygget använder global node-gyp@10), ta bort övriga metadatafält
- Bygg via `setup-lotus.sh`: `cd pi/vendor/alsa-capture && npm install --ignore-scripts && node-gyp rebuild --release`
- `pi/src/alsaMic.ts` importerar med fallback-kedja: `vendor/alsa-capture/index.js` → `npm:alsa-capture` → `node-record-lpcm16` (arecord)
- Tagit bort `alsa-capture` ur `pi/package.json` `optionalDependencies` — vendor-pathen är primary

**Krav för bygget på Pi:**
- node-gyp@10 globalt: `sudo npm install -g node-gyp@^10`
- libasound2-dev: `sudo apt install -y libasound2-dev`
- build-essential, python3 (3.11+ funkar, 3.13 funkar med node-gyp@10)

**Verifiering:**
```bash
ls /opt/lotus-light/pi/vendor/alsa-capture/build/Release/capture.node
sudo journalctl -u lotus-light-engine -n 30 --no-pager | grep ALSA
# ska säga: [ALSA] Using native alsa-capture (vendored fork, direct snd_pcm_readi)
```

**Lärdom:** När en native-modul har två separata kompatibilitetsproblem (Python + V8) och är övergiven — vendora hellre än att stapla workarounds runt npm-installet. Att äga koden är billigare än att kämpa mot lifecycle-scripts.
