---
name: ALSA buffer = 8× period (inte 2×) på Pi Zero 2W
description: Native alsa-capture buffer måste vara minst 8× period-storleken på Pi Zero 2W. 2× ger konstanta overruns eftersom JS-eventloopen (FFT + BLE writeAsync) regelbundet blockerar 2-4ms, vilket är längre än 2×32 frames = 1.4ms.
type: constraint
---
**Symptom:** `[ALSA] Buffer overrun detected` spammar engine-loggen ~20+ ggr/sek, BLE-write går till 0 pkt/s eftersom audio-pipelinen kollapsar (snd_pcm_prepare-loopen blockerar capture-tråden från att leverera frames till JS).

**Rotorsak:** Bufferten var satt till `period × 2` (64 frames = ~1.4ms @ 44.1kHz). På Pi Zero 2W tar JS-eventloopen normalt 2-4ms per cykel pga FFT-beräkning och BLE writeAsync-anrop. När capture-tråden hinner fylla bufferten innan JS plockar upp den → EPIPE → snd_pcm_prepare → loopen kollapsar.

**Fix (capture.cc):** `snd_pcm_uframes_t bufFrames = frames * 8;` (256 frames = ~5.8ms). Behåller liten period (32 frames = 0.7ms latency per frame) men ger headroom för JS-jitter.

**Lärdom:** Period-storleken styr latensen (hur snabbt frames levereras). Buffer-storleken styr hur mycket jitter systemet tål innan overrun. Dessa är ortogonala — minska periodSize för låg latens, öka buffer×period-multiplikator för stabilitet.
