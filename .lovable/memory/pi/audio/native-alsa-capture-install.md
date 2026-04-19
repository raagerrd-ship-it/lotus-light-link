---
name: alsa-capture omskriven som N-API addon (node-addon-api)
description: Original alsa-capture@0.3.0 (NAN-baserad) bröts av tre separata Node 24/V8 14-inkompatibiliteter i nan-templates. Lösning: vendora om i pi/vendor/alsa-capture/ ovanpå node-addon-api (N-API v8) — ABI-stabilt över alla Node-versioner.
type: constraint
---
**Symptom (Node 24 + nan@2.26.2):** Tre separata kompileringsfel i tredjeparts-headers:
1. `Nan::Get(options, Nan::New<String>("x"))` — `nan@2.26.2` har bara överlast för `Local<Value>`/`uint32_t` som key, ej `Local<String>`
2. `new Persistent<Function>(local)` — V8 14 har tagit bort `Persistent(Isolate*, Local<S>)`-konstruktorn som nan använder internt i `nan_persistent_12_inl.h:18`
3. `info[i]->IsUndefined()` i `streaming-worker.h:221` — V8 14:s `FunctionCallbackInfo::operator[]` returnerar `Local<Primitive>` när out-of-range, vilket nan inte hanterar

**Rotorsak:** Att stapla workarounds på `nan` är en återvändsgränd. NAN exponerar V8-templates direkt och bryts varje gång V8 gör ABI-ändringar.

**Lösning (2026-04-19):** Skrev om addon i N-API ovanpå `node-addon-api@^8.3.0`:
- `pi/vendor/alsa-capture/capture.cc` — ~200 rader, använder `Napi::ObjectWrap<CaptureWorker>` + `Napi::ThreadSafeFunction` för att posta audio-frames från capture-tråden till JS-callbacken utan blockering
- `binding.gyp` använder `node-addon-api`'s include-path och `defines: ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS=1"]`
- JS-API:t i `index.js` är **oförändrat** — `new Capture.StreamingWorker(onMessage, onClose, onError, opts)` + `.closeInput()`
- N-API är ABI-stabilt över Node 18+, så ingen omkompilering krävs vid Node-uppgraderingar och inga V8-fel uppstår

**Krav för bygget:** node-gyp@10, libasound2-dev, gcc med C++17. Python-versionen spelar ingen roll med node-gyp@10.

**Verifiering:**
```bash
ls /opt/lotus-light/pi/vendor/alsa-capture/build/Release/capture.node
sudo journalctl -u lotus-light-engine -n 30 --no-pager | grep ALSA
# ska säga: [ALSA] Using native alsa-capture (vendored fork, direct snd_pcm_readi)
```

**Lärdom:** För native Node-addons — använd alltid N-API (`node-addon-api`), aldrig NAN. NAN kräver att tredje part jagar V8-ABI per Node-version, N-API är garanterat stabilt.
