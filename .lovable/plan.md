

## Undersökning: Native ALSA-binding vs node-record-lpcm16

### Nuläge

`node-record-lpcm16` spawnar `arecord` som subprocess och pipar PCM-data via stdout. Detta ger ~0.5–1ms IPC-overhead per chunk plus extra process-scheduling-latens.

### Bästa kandidat: `alsa-capture`

Paketet [`alsa-capture`](https://github.com/meldron/node-alsa-capture) är en native C++ addon (node-gyp) som anropar ALSA:s `snd_pcm_readi()` direkt i Node.js processen — ingen subprocess, ingen pipe.

**Fördelar:**
- Eliminerar `arecord`-subprocess + pipe-IPC (~0.5–1ms latens bort)
- Konfigurerbar `periodSize` — kan sättas till exakt 128 samples för att matcha vår FFT-hop
- Emittar `audio`-event med `Uint8Array` — redan rätt format
- Rapporterar overruns och avvikande sample rates via events
- Kräver bara `libasound2-dev` (redan installerat på Pi:n)

**Risker:**
- Kräver `node-gyp` build på Pi:n (ARM, tar ~1 min)
- Senaste commit 2021, men ALSA API:t är stabilt — bör fungera
- Om `node-gyp` inte bygger kan vi falla tillbaka till nuvarande lösning

### Plan

1. **Installera `alsa-capture`** i `pi/package.json`
2. **Refaktorera `alsaMic.ts`** — byt ut `node-record-lpcm16` mot `alsa-capture`:
   - `new AlsaCapture({ channels: 1, rate: 44100, format: 'S16_LE', device: currentDevice, periodSize: 128 })`
   - Lyssna på `audio`-event istället för stream `data`
   - Använd `Int16Array`-vy direkt på buffern (ingen `readInt16LE`-loop)
   - Bitmask `& 0x3FF` istället för `% 1024` för ringbuffer
3. **Ta bort `node-record-lpcm16`** från dependencies
4. **Uppdatera `setup-lotus.sh`** — lägg till `libasound2-dev` i apt-install om det saknas
5. **Fallback-kommentar** i koden ifall native addon inte kan byggas

### Förväntad förbättring

- Latens: ~0.5–1ms lägre (från ~3.4ms till ~2.5ms per frame)
- CPU: Marginellt lägre (ingen extra process)
- Stabilitet: Overrun-events ger bättre diagnostik

### Teknisk detalj

```typescript
// Före (node-record-lpcm16)
recorder = record.record({ sampleRate: 44100, ... });
recorder.stream().on('data', (buf: Buffer) => { ... });

// Efter (alsa-capture)
capture = new AlsaCapture({ rate: 44100, channels: 1, format: 'S16_LE', 
                             device: currentDevice, periodSize: 128 });
capture.on('audio', (buf: Uint8Array) => {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    let raw = (samples[i] / 32768) * micGain;
    if (raw > 0.5 || raw < -0.5) raw = Math.tanh(raw);
    ringBuf[ringPos] = applyHighShelfSample(raw);
    ringPos = (ringPos + 1) & 0x3FF;
  }
  processFFT();
});
```

