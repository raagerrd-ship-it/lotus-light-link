# ANDRA PASS (opt/förenkla) — Agent 6: configServer / storage / sonos / mobil-UI

**Största temat pass 1 missade: mycket av "het-path"-kostnaden matar UI som ALDRIG monteras.** App.tsx routar
bara PiMobile; PiMobile importerar bara PermissionsBanner/piUi/LightPreview/BeatMonitor. Resten är dött.

## 1 · simplify · HIGH — FYRA hela UI-komponenter är död kod (aldrig monterade) + fantom-pollers
- src/components/LiveStrip.tsx, RestartHistoryPanel.tsx, BleControlPanel.tsx, SubsystemStartupPanel.tsx
  (+ MicBackendBadge.tsx + inline VuMeter som bara SubsystemStartupPanel använder). Noll importer.
- De innehåller pollerna granskningen oroade sig för — men de KÖR INTE (monteras ej): BleControlPanel pollar
  /api/ble/output @200ms(5Hz) (:127) + /api/ble/state @2s; RestartHistoryPanel /api/status @10s;
  SubsystemStartupPanel 3 samtidiga intervall; LiveStrip /api/status @4Hz. HALVA kodbasens pollers är fantom.
- Föräldralösa engine-endpoints då: /api/ble/output, /api/ble/state, /api/mic/level, /api/subsystem/status.
- Fix: radera de 4 komponenterna + MicBackendBadge/VuMeter; överväg ta bort de nu döda endpoints. Noll beteende
  i körande appen. (Detta är samma 3 komponenter som housekeeping-prompten redan tar — men agenten hittade 4:e
  + MicBackendBadge/VuMeter.) Confidence hög.

## 2 · optimize · HIGH — /api/status en tung payload vars tyngsta fält ingen MONTERAD läser
- configServer.ts:428-573. Live-konsumenter: BeatMonitor(:32/45,1Hz), GainCalibrationPanel(:403-427,1Hz),
  PiMobile(:940/956,5s). INGEN mager endpoint (health saknar level/lastSent/beat).
- Payload buntar restarts.slice(-20)(556-59), subsystemTransitions.slice(-30)(563-66), subsystems(568-71),
  bleStats(498), analyser(547), analyserCost, runtime, sonos m. 2 paletter, live(10 fält) — ~3-6 KB. Spårade
  vad MONTERADE faktiskt läser: BeatMonitor→data.beat; GainCal→ble.lastSent.pct+live.inputLevel; PiMobile→
  engine, sonos.playbackState/volume, ble.connected. Allt annat (restarts/transitions/subsystems/analyser/
  analyserCost/runtime/ble.stats/idle/live.palette*/track/queue/outputBrightness) läses BARA av de döda #1.
- → engine bygger+stringify:ar 50 array-poster ~2×/s över WiFi/BLE-delade radion för att slängas.
- Fix: additiv mager /api/live {ble:{connected,lastSent},live:{inputLevel},sonos:{playbackState,volume},engine,
  beat}; peka BeatMonitor+GainCal+PiMobile dit. Behåll /api/status (?full=1) för framtida diagnostik. Confidence
  hög (grep:at vem-läser-vad), låg risk.

## 3 · optimize · MED — Tre oberoende /api/status-pollers på monterade sidan → en, + pausa när dold
- BeatMonitor:45(1Hz), GainCal PiMobile:423(1Hz +/api/auto-gain), PiMobile:956(5s). /api/status hämtas 2×/s av
  två alltid-monterade komponenter som inte känner varandra; ingen pausar vid document.hidden.
- Fix: lyft EN delad poller till PiMobile (mager endpoint från #2) 1/s, skicka ner beat/inputLevel/lastSent/
  sonos/engine som props; guard document.visibilityState==='hidden'. Förbättrar även deras tids-synk (:136).

## 4 · optimize · MED — sonosPoller SSE-paus kan tyst faila → poll-timern återuppstår, kollar aldrig sseActive
- sonosPoller.ts:289-314 (poll) vs :326-332 (SSE onopen→stopPollTimer). arm()-callbacken sätter pollTimer=null
  FÖRE await (293), finally re-arm:ar ALLTID (309), kollar aldrig sseActive. Race: pågår en poll när SSE onopen
  kör stopPollTimer hittar den pollTimer===null (rensar inget); pollens finally armar ny timer SSE ej kan stoppa
  → poll-loop kör PARALLELLT med SSE för alltid → Sonos-trafik dubblas tyst på BLE-delade radion.
- Fix: `finally{ pollInFlight=false; if(!sseActive) arm(currentPollMs()); }` + `if(sseActive){pollTimer=null;
  return;}` högst upp i callbacken. Nit: stopSonosPoller:383 clearInterval på setTimeout-handle → clearTimeout.
- Confidence hög (spårat), låg risk. DISTINKT från backoff-fixen i pass 1.

## 5 · simplify · MED — ~8 nästan identiska skalär-knopp GET/PUT-par är tabell-drivbara
- /api/dimming-gamma(1221-35), tick-ms PUT(849-61), idle-color(832-46), auto-tv-mode(1238-51), mic-gain(1148-
  63), raw-mode(803-14), ble/rate-limit(867-80), mic-device(994-1010). ~120 rader strukturell dubblering.
- Fix: liten defineKnob(app,{path,key,parse,min,max,apply,read,serialize})-registrar. BEHÅLL sido-effekter per
  knopp (tick-ms→restartTimer 855, idle-color→invalidateIdleColorCache 841, rate-limit/tick slot-lease) via
  per-knopp apply-callback. Med risk (sido-effekter + distinkta 400-meddelanden måste bevaras).

## 6 · optimize · LOW-MED — /api/status gör 5 dynamiska await import() per request
- configServer.ts:432,433,470,479,486 (connect/restartLog/protocol/controllerDrain/engineLifecycle). Alla laddas
  vid boot → cache-träff, men 5 async-microtask-hopp × ~2 req/s. Hoista till statiska top-imports (interna
  moduler, ingen load-order-fara när servern lyssnar). Verifiera ingen äkta cirkulär-import-orsak. Noll beteende.

## 7 · simplify · LOW — småsaker
- PiMobile.tsx:1 importerar useCallback — oanvänt. GET /api/sonos-gateway skriver setItem(:1330) inne i en GET
  (SD-write på läs-väg — pass 1 flaggade, kvar). normalizeSonosGatewayConfig:1269 listar '172.0.0.1:3003' =
  trolig typo för 127.0.0.1.

**Mest impactful:** #1 (radera 4 döda komponenter) + #2 (mager endpoint) tar bort merparten av redundant radio-
trafik + ~halva pollerytan; #3+#4 stänger resten av WiFi-BLE-contention.
