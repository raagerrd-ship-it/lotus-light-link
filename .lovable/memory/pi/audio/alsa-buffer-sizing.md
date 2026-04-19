---
name: ALSA period/buffer kopplad till tickMs
description: Native alsa-capture periodSize = round(tickMs/2 * 44.1) frames → exakt 2 FFT-frames per engine-tick. Buffer = 4× period (~50ms headroom @ 25ms tick). HOP_SIZE uppdateras live via setTickHopMs() som auto-restartar capture.
type: constraint
---
**Relation:** `periodSize_frames = round(tickMs / 2 * 44.1)`. Default 25ms tick → ~551 frames = ~12.5ms per audio-frame → 2 FFT/tick (snabbare onset än 1×, halv CPU vs hop=128).

**Buffer:** `bufFrames = period × 4` ger ~50ms headroom för JS-eventloop-jitter (FFT + BLE writeAsync på Pi Zero 2W tar 2-4ms per cykel). Tidigare 2× → konstanta overruns → engine kollapsade → 0 BLE pkt/s. 8× testades men onödigt mycket nu när periodSize är stort.

**Live-omkonfig:** `engine.setTickMs(ms)` kallar `setTickHopMs(ms)` i alsaMic.ts som auto-restartar capture om aktiv (~200ms audio-glitch). Konstruktorn i PiLightEngine kallar setTickHopMs vid init så period är synkad innan startMic.

**Lärdom:** Period-storleken styr latens-granularitet (hur ofta FFT körs). Buffer × period styr jitter-tolerans. Med tick-styrd period håller vi audio-arrival och engine-tick i fas — annars driver de mot varann och engine processar antingen samma data flera ggr eller missar frames.
