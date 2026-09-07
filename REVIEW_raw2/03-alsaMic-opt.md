# ANDRA PASS (opt/förenkla) — Agent 3: alsaMic.ts + capture.cc (native)

## 1 · optimize · MED — Ring-drain kopierar 128 sampel/hop med per-element-mask → bulk .set(subarray)
- alsaMic.ts:924 `for(i<128) analyserScratch[i]=ringBuf[(start+i)&mask]`. 375 hops/s → ~48000 maskade skalär-
  läsningar/s = största undvikbara per-sampel-klass-kostnaden. start wrappar bara ~12.5% av hops.
- Fix (noll beteende): `if(start+128<=RING_SIZE) analyserScratch.set(ringBuf.subarray(start,start+128)); else
  {loop}`. analyser.process() återanvänder scratch varje hop → behåller ej bufferten. Confidence hög.

## 2 · optimize · LOW-MED — Hi-shelf räknar (rawPre-hs) TVÅ ggr/sampel → återanvänd delta + folda konstanten
- alsaMic.ts:864-865 (+S16-tvilling 883-886) `hs+=hsAlpha*(rawPre-hs); ring[pos]=hs+(rawPre-hs)*hsG`. Andra
  subtraktionen onödig: hs_new+(rawPre-hs_new)*hsG == hs_new+d*(1-α)*hsG, d=rawPre-hs_old. ALLTID på (varje
  sampel, båda taparnas delade filter) → ~48000 subs/s. Fix: `const HS_D_COEFF=(1-HS_ALPHA)*hsGain; const
  d=rawPre-hs; hs+=hsAlpha*d; ring[pos]=hs+d*HS_D_COEFF;`. Exakt algebra, mycket låg risk. Bredaste per-sampel-vinsten.

## 3 · simplify · MED — Per-sampel kalibrerings-ackumulatorn är byte-för-byte redundant med ljus-RMS-ackumulatorn
- alsaMic.ts:840-844/853/874/908-912. calOn fångas 1×/callback → calSumLocal ackumulerar EXAKT samma rawPre²
  över samma frames som lightSumLocal; calCntLocal===lightCntLocal===frameCount. Hela cal-grenen i het-loopen =
  dubbelarbete (per-sampel `if(calOn)` utvärderas varje sampel @48kHz). Djupare än pass 1 (som bara såg räknarna
  lika). Fix: radera per-sampel cal-gren i BÅDA loopar; commit `if(calOn){micCalSumSq+=lightSumLocal; micCalCount
  +=frameCount; ...}`. Kräver frameCount i funktions-scope (#7). Confidence hög.

## 4 · optimize · MED — capture.cc: en memcpy + en heap-vector-alloc kvar per callback (NATIVE, rebuild)
- capture.cc:222 (persistent readBuf), 246 (`vector out(readBuf.data()...)` = memcpy), EmitAudio 136-139 (`new
  vector(std::move(bytes))` = 2:a heap-vector för finalizern). readBuf kopieras till out (~2KB×187/s≈380KB/s), sen
  moved till 3:e vector. Fix: läs direkt i per-iter frameBuf, resize-down (ingen realloc), EmitAudio(std::move);
  backa Buffer med f->bytes.data() + fria AudioFrame i finalizern (släng unique_ptr+new vector). Rebuild krävs.

## 5 · simplify · LOW-MED — micGain är ALLTID identisk med micGainAuto (rest av borttaget manuellt läge)
- alsaMic.ts:498/500-501/388/896/522. updateEffectiveGain enda writer: micGain=micGainAuto. getEffectiveGain()==
  getAutoGainMultiplier() alltid. Fix: ta bort micGain, använd micGainAuto; behåll seed-on-large-change genom att
  jämföra ny vs förra micGainAuto. Klarhet. Verifiera ingen extern läsare kräver att de två getters divergerar.

## 6 · optimize · LOW-MED — capture.cc: event-TSFN fortf. obegränsad (queue=0) — parallell heap-växt vid stall (NATIVE)
- capture.cc:83-84 eventTsfn_ maxQueueSize 0, från :228 (overrun) via EmitEvent (new EventMessage/event). Pass 1
  bounded AUDIO-TSFN till 4 men event-TSFN kvar obegränsad → vid XRUN-storm växer heap tyst medan JS fryst. Fix:
  maxQueueSize~8 + delete msg vid napi_queue_full (spegla EmitAudio). Rebuild krävs.

## 7 · simplify · LOW — newSamples/lightCntLocal/calCntLocal är frameCount den svåra vägen
- alsaMic.ts:892-894 (prevRingPos + newSamples=(pos-prevRingPos)&mask) == frameCount alltid (256<RING_SIZE);
  lightCntLocal också. Fix: `let frameCount` i funktions-scope, använd direkt; radera prevRingPos/newSamples/
  lightCntLocal/calCntLocal. Möjliggör #3.

## 8 · simplify · LOW — emitBands dubbel-dividerar shares + multiplicerar med död BAND_SCALE
- alsaMic.ts:388 (*BAND_SCALE=1.0), 397-98 vs 408-09 (lowAbs/totAbs + hiAbs/totAbs beräknas 2×). Fix: `const
  lowFrac=lowAbs/totAbs, hiFrac=hiAbs/totAbs`, lowShare=min(1,lowFrac*2), bassShare=lowFrac; släng *BAND_SCALE.
  ~4 divs/emitBands bort. 75Hz → tidy-up.

## 9 · simplify · LOW — capture.cc stale defaults/doc-drift + "downmix"-felmärkning
- capture.cc:1-6 header + defaults 33-38 (ch=1,S16,period=32,44100) matchar EJ runtime (stereo S32,256,8×,48k
  forcerat från JS). alsaMic.ts:751 loggar "stereo→mono downmix" men tar VÄNSTER kanal (samples[i<<1]) = ej downmix.
  Uppdatera doc + logg "left-channel select". Ren dokumentation.

## 10 · simplify · LOW — ACR WAV bygger 80000 sampel en writeInt16LE i taget (:363)
- Cold path (bara ACR-identify). Fix: `Buffer.from(acrBuf.buffer,acrBuf.byteOffset,acrLen*2).copy(buf,44)` (LE på
  ARM). Låg prio.

**Kvar från pass 1 (ej implementerat): debug-only prePeak abs+compare per sampel (862-63/883) fortf. ovillkorligt
→ gate bakom DEBUG_ENABLED; acrBuf 160KB eager-allokerad (321). Verifierat rent: tvåtapps-splittet har INGEN
duplicerad per-sampel-konvertering (utom #3 cal/light). Högst ROI: #1+#2 (breda per-sampel), #3 (per-sampel-gren
bort), #4 (per-callback memcpy+alloc, rebuild), #6 (obegränsad heap-hardening, rebuild).**
