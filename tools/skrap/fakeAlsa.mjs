// FALSK ALSA-CAPTURE for skrapbanken: spelar spellistans WAV:ar (48 kHz mono 16-bit, micens raa inspelning ur korpusen)
// i realtid som S32_LE stereo i perioder om 256 ramar, en NY Buffer per period (som den nativa bindningen, som skapar en
// extern Buffer per period). Spellistan och starttiden delas med den falska gatewayen (HARNESS_PLAYLIST, HARNESS_T0) sa
// latbytet i ljudet och i Sonos-statusen sker samtidigt.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const PL = JSON.parse(fs.readFileSync(process.env.HARNESS_PLAYLIST, 'utf8'));
const T0 = Number(process.env.HARNESS_T0) || Date.now();
const SR = 48000, PERIOD = 256;
const total = PL.reduce((a, s) => a + s.seconds, 0);

function songAt(sec) {
  let t = ((sec % total) + total) % total;
  for (let i = 0; i < PL.length; i++) { if (t < PL[i].seconds) return [i, t]; t -= PL[i].seconds; }
  return [0, 0];
}

export default class AlsaCapture extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; this.closed = false; this.fd = -1; this.fdSong = -1; this.dataOff = 44;
    this.chunk = Buffer.alloc(PERIOD * 2);
    // sampelposition i den globala tidslinjen (fran T0), i 48 kHz-sampel
    this.pos = Math.max(0, Math.floor((Date.now() - T0) / 1000 * SR));
    this.startWall = performance.now(); this.startPos = this.pos;
    setTimeout(() => this.loop(), 5);
  }
  openSong(i) {
    if (this.fd >= 0) fs.closeSync(this.fd);
    this.fd = fs.openSync(PL[i].wav, 'r'); this.fdSong = i;
    const h = Buffer.alloc(4096); fs.readSync(this.fd, h, 0, 4096, 0);
    let off = 12; this.dataOff = 44;
    while (off + 8 <= h.length) { const id = h.toString('ascii', off, off + 4), len = h.readUInt32LE(off + 4); if (id === 'data') { this.dataOff = off + 8; break; } off += 8 + len + (len & 1); }
  }
  readPeriod(out) {
    const [i, t] = songAt(this.pos / SR);
    if (i !== this.fdSong) this.openSong(i);
    const s0 = Math.floor(t * SR);
    const got = fs.readSync(this.fd, this.chunk, 0, PERIOD * 2, this.dataOff + s0 * 2);
    for (let k = 0; k < PERIOD; k++) {
      const v = 2 * k < got ? this.chunk.readInt16LE(2 * k) : 0;
      const s32 = v * 65536;
      out.writeInt32LE(s32, k * 8); out.writeInt32LE(s32, k * 8 + 4);
    }
    this.pos += PERIOD;
  }
  loop() {
    if (this.closed) return;
    const due = this.startPos + Math.floor((performance.now() - this.startWall) / 1000 * SR);
    let n = 0;
    while (this.pos + PERIOD <= due && n < 32) {
      const buf = Buffer.allocUnsafeSlow(PERIOD * 8);   // som den nativa bindningen: ny extern Buffer per period
      this.readPeriod(buf);
      this.emit('audio', buf); n++;
    }
    if (this.pos + PERIOD * 64 < due) { this.pos = due; }   // hann inte med (paus i processen) -> hoppa fram som ALSA-overrun
    setTimeout(() => this.loop(), 5);
  }
  close() { this.closed = true; if (this.fd >= 0) { fs.closeSync(this.fd); this.fd = -1; } this.emit('close'); }
}
