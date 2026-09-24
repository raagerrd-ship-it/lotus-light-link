/**
 * INSPELAREN (2026-09-24) — egen modul BREDVID analysatorn, samma fil i lotus-light-link och dmx-control.
 * Analysatorn vet ingenting om den: inspelaren far ljudet fran INPUT-LAGRET (samma sampel som analysatorn
 * matas med, i block per ljudcallback) och laser handelser (drop, sektion, gridfas) ur analysatorns vanliga
 * utdata (Frame). Allt systemspecifikt (latnyckel, tempocache, ljusstyrka, motorns pulser, uppspelningslage)
 * kommer in som krokar; malkatalog, storlekar och av/pa som konfiguration.
 *
 * Tva slag av fangst, samma vag:
 *   'tempo'   tempoDelayS in i laten, tempoS sekunder (standard 10 s in, 30 s)
 *   'drop'    nar analysatorns dropCount andras (eller pa begaran): dropPreS fore (forbuffert) + dropPostS efter
 *   'section' (opt-in sectionS > 0) en lang fangst i stallet for tempofangsten, hogst sectionMax latar
 * Under fonstret loggas kickar, gridpulser, ljusstyrka (10 Hz), drop/sektionsflaggor och gridfas -> <id>.events.json
 * bredvid WAV:en (48 kHz mono 16-bit). Ko max queueMax filer; en hamtare (PC:n) tar dem och raderar.
 *
 * Kostnad nar den ar AV (enabled=false och ingen forbuffert): push() ar en tom metod.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

/** De Frame-falt inspelaren laser (analysatorns Frame uppfyller detta). */
export interface RecorderFrame {
  dropCount: number; inRiser?: boolean; buildUp?: number; breaking?: boolean; inZone?: boolean;
  section?: string; sectionIndex?: number; repeatSim?: number; repeatAgoMs?: number;
  beatPhaseMs?: number; beatPhaseConf?: number; bpm?: number;
}

export interface RecorderHooks {
  /** Analysatorns senaste ram. */
  latestFrame(): RecorderFrame | null;
  /** Kick-tider (vaggklocka ms) ur input-lagrets kickring. */
  recentKicks?(): number[];
  /** Ljusstyrka 0..100 som faktiskt skickades (loggas 10 Hz). */
  brightness?(): number | undefined;
  /** Motorns taktpulser (vaggklocka) sedan sinceMs, och motorns taktinfo. */
  pulses?(sinceMs: number): unknown;
  beatInfo?(): unknown;
  /** Spelar musiken? (dropfangst bara under uppspelning; saknas = alltid) */
  isPlaying?(): boolean;
  /** Ar allt som fangsten behover pa plats? (saknas = ja) */
  ready?(): boolean;
  /** Stabil nyckel for en lat. */
  songKey(artist: string, title: string): string;
  /** Finns redan en tempofangst/analys for laten? (da hoppas tempofangsten over) */
  hasTempo?(key: string): boolean;
  /** Har laten redan fatt sin langa sektionsfangst? / markera att den tas nu. */
  hasSection?(key: string): boolean;
  markSection?(key: string): void;
  /** Blockerat just nu (t.ex. TV-lage) for den langa sektionsfangsten. */
  sectionBlocked?(): boolean;
  /** Manuell begaran ('drop' m.fl.) sedan senast, eller null. */
  takeManual?(): string | null;
  log?(msg: string): void;
}

export interface RecorderConfig {
  /** Malkatalog for fangsterna (skapas vid behov). */
  dir: string;
  sampleRate?: number;              // 48000
  /** Standardlage for fangsterna; enabledFile (om satt) sparar/laser brytaren. */
  enabled?: boolean;
  enabledFile?: string;
  queueMax?: number;                // 30
  tempoDelayS?: number;             // 10
  tempoS?: number;                  // 30
  dropPreS?: number;                // 15
  dropPostS?: number;               // 15
  dropMaxPerSong?: number;          // 2
  dropPollMs?: number;              // 250
  sectionS?: number;                // 0 = av (tak 150)
  sectionMax?: number;              // 40
  sectionCountFile?: string;
}

// Fri ra-fangst (manuell eller fangst ovan): 16 kHz-decimerad som standard, full takt pa begaran.
const RAW_RATE = 16000;
const RAW_MAX_SECONDS = 420;
const PRE_SECONDS = 15;

export class Recorder {
  private readonly sr: number;
  private readonly cfg: Required<Omit<RecorderConfig, 'enabledFile' | 'sectionCountFile'>> & Pick<RecorderConfig, 'enabledFile' | 'sectionCountFile'>;
  private readonly hooks: RecorderHooks;
  // ── ljudbuffertar ─────────────────────────────────────────────────────────────
  private preBuf: Int16Array | null = null; private prePos = 0; private preFilled = 0; private readonly preLen: number;
  private rawActive = false; private rawBuf: Int16Array | null = null; private rawLen = 0; private rawTarget = 0;
  private rawRate = RAW_RATE; private rawDecimN: number; private rawDecim = 0; private rawAcc = 0;
  private rawStartWallMs = 0; private rawPrerollSamples = 0; private rawLabelStr = '';
  // ── fangstlogik ───────────────────────────────────────────────────────────────
  private enabled: boolean;
  private busy = false; private trackChangeMs = 0;
  private lastTrack: string | null = null; private lastArtist: string | null = null;
  private dropsThisSong = 0; private lastDropCount = -1;
  private sectionCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: RecorderConfig, hooks: RecorderHooks) {
    this.sr = cfg.sampleRate ?? 48000;
    this.cfg = {
      dir: cfg.dir, sampleRate: this.sr, enabled: cfg.enabled ?? true, enabledFile: cfg.enabledFile,
      queueMax: cfg.queueMax ?? 30, tempoDelayS: cfg.tempoDelayS ?? 10, tempoS: cfg.tempoS ?? 30,
      dropPreS: cfg.dropPreS ?? 15, dropPostS: cfg.dropPostS ?? 15, dropMaxPerSong: cfg.dropMaxPerSong ?? 2, dropPollMs: cfg.dropPollMs ?? 250,
      sectionS: Math.min(150, cfg.sectionS ?? 0), sectionMax: cfg.sectionMax ?? 40, sectionCountFile: cfg.sectionCountFile,
    };
    this.hooks = hooks;
    this.preLen = this.sr * PRE_SECONDS;
    this.rawDecimN = this.sr / RAW_RATE;
    this.enabled = this.cfg.enabled;
    if (cfg.enabledFile) { try { this.enabled = JSON.parse(readFileSync(cfg.enabledFile, 'utf8')).enabled !== false; } catch { /* standard */ } }
    if (cfg.sectionCountFile) { try { this.sectionCount = Number(JSON.parse(readFileSync(cfg.sectionCountFile, 'utf8')).count) || 0; } catch { /* forsta gangen */ } }
  }

  private log(m: string): void { (this.hooks.log ?? console.log)(m); }

  // ── LJUD IN (input-lagret, per callback) ─────────────────────────────────────────────────────
  /** Rasampel i [-1,1] (samma sampel som analysatorn far), n = antal giltiga i blocket. */
  push(block: Float32Array, n = block.length): void {
    const pre = this.preBuf;
    if (!pre && !this.rawActive) return;
    const PL = this.preLen;
    for (let i = 0; i < n; i++) {
      const x = block[i];
      if (pre) {
        let pv = x * 32767; if (pv > 32767) pv = 32767; else if (pv < -32767) pv = -32767;
        pre[this.prePos] = pv; if (++this.prePos >= PL) this.prePos = 0; if (this.preFilled < PL) this.preFilled++;
      }
      if (this.rawActive && this.rawBuf && this.rawLen < this.rawTarget) {
        if (this.rawStartWallMs === 0) this.rawStartWallMs = Date.now();
        this.rawAcc += x;
        if (++this.rawDecim >= this.rawDecimN) {
          let r = (this.rawAcc / this.rawDecimN) * 32767;
          if (r > 32767) r = 32767; else if (r < -32768) r = -32768;
          this.rawBuf[this.rawLen++] = r;
          this.rawDecim = 0; this.rawAcc = 0;
          if (this.rawLen >= this.rawTarget) this.rawActive = false;
        }
      }
    }
  }

  /** Rullande forbuffert (PRE_SECONDS @ full takt) sa en dropfangst kan borja fore handelsen. */
  enablePreroll(on: boolean): void {
    if (on) { if (!this.preBuf) this.preBuf = new Int16Array(this.preLen); }
    else { this.preBuf = null; this.prePos = 0; this.preFilled = 0; }
  }

  // ── RA-FANGST (manuell eller via fangstlogiken) ────────────────────────────────────────────────
  /** Starta en ra-fangst. fullRate = samma takt som in (annars 16 kHz-medel). prerollS = borja sa langt fore nu (forbufferten). */
  startRaw(seconds: number, label?: string, fullRate = false, prerollS = 0): number {
    const sec = Math.max(1, Math.min(fullRate ? 150 : RAW_MAX_SECONDS, Math.round(seconds)));
    this.rawLabelStr = (label ?? '').slice(0, 120);
    this.rawRate = fullRate ? this.sr : RAW_RATE; this.rawDecimN = fullRate ? 1 : this.sr / RAW_RATE;
    const pre = (fullRate && prerollS > 0 && this.preBuf) ? Math.min(this.preFilled, this.sr * Math.min(PRE_SECONDS, Math.round(prerollS))) : 0;
    this.rawTarget = this.rawRate * sec + pre;
    this.rawDecim = 0; this.rawAcc = 0;
    if (!this.rawBuf || this.rawBuf.length < this.rawTarget) this.rawBuf = new Int16Array(this.rawTarget);
    this.rawLen = 0; this.rawPrerollSamples = pre; this.rawStartWallMs = 0;
    if (pre > 0 && this.preBuf) {
      let src = this.prePos - pre; if (src < 0) src += this.preLen;
      const n1 = Math.min(pre, this.preLen - src);
      this.rawBuf.set(this.preBuf.subarray(src, src + n1), 0);
      if (n1 < pre) this.rawBuf.set(this.preBuf.subarray(0, pre - n1), n1);
      this.rawLen = pre;
      this.rawStartWallMs = Date.now() - (pre / this.sr) * 1000;
    }
    this.rawActive = true;
    return sec;
  }
  rawStatus(): { active: boolean; seconds: number; done: boolean; label: string } {
    return { active: this.rawActive, seconds: this.rawLen / this.rawRate, done: this.rawLen >= this.rawTarget && this.rawTarget > 0, label: this.rawLabelStr };
  }
  /** Filnamnsvanlig etikett, t.ex. "ricky-rose-utan-dig-90". */
  rawLabel(): string { return this.rawLabelStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  /** Vaggklocka for WAV:ens sampel 0 och antal sampel ur forbufferten. */
  rawMeta(): { startWallMs: number; prerollSamples: number; rate: number } {
    return { startWallMs: this.rawStartWallMs, prerollSamples: this.rawPrerollSamples, rate: this.rawRate };
  }
  /** WAV av det som samlats (minst 1 s). Avslutar fangsten; stora buffertar slapps. */
  takeWav(): Buffer | null {
    if (!this.rawBuf || this.rawLen < this.rawRate) return null;
    this.rawActive = false;
    const dataBytes = this.rawLen * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(this.rawRate, 24); buf.writeUInt32LE(this.rawRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
    Buffer.from(this.rawBuf.buffer, this.rawBuf.byteOffset, dataBytes).copy(buf, 44);   // little-endian = WAV
    if (this.rawBuf.length > this.sr * 31) this.rawBuf = null;   // behall 30 s-bufferten, slapp langa
    this.rawLen = 0;
    return buf;
  }

  // ── BRYTARE ──────────────────────────────────────────────────────────────────────────────────
  isEnabled(): boolean { return this.enabled; }
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.cfg.enabledFile) import('node:fs/promises').then((fsp) => fsp.writeFile(this.cfg.enabledFile!, JSON.stringify({ enabled: on, at: Date.now() }))).catch(() => { /* brytaren far aldrig falla motorn */ });
    this.log(`[tempo] fangster ${on ? 'PA' : 'AV'} (capture-enabled)`);
  }

  // ── LATBYTEN ─────────────────────────────────────────────────────────────────────────────────
  /** Varje (odebouncad) latnamnsandring: aktuell lat + var en pagaende fangst ska klippas. */
  noteTrack(name: string | null, artist?: string | null): void {
    if (artist !== undefined) this.lastArtist = artist;
    if (name === this.lastTrack) return;
    if (this.busy && !this.trackChangeMs) this.trackChangeMs = Date.now();
    this.lastTrack = name;
  }
  /** Bekraftat latbyte (debouncat): planera latens forsta fangst tempoDelayS in. */
  trackChanged(artist: string | null, title: string): void {
    this.dropsThisSong = 0;
    setTimeout(() => {
      try {
        if (title !== this.lastTrack || (this.hooks.ready && !this.hooks.ready())) return;
        const key = this.hooks.songKey(artist || '', title);
        const S = this.cfg.sectionS;
        if (S > 0 && !this.hooks.hasSection?.(key) && this.sectionCount < this.cfg.sectionMax && !this.hooks.sectionBlocked?.() && !this.busy) {
          // raknas bara nar fangsten faktiskt startar (busy -> vanlig tempofangst nasta gang i stallet)
          this.sectionCount++; this.saveSectionCount();
          this.hooks.markSection?.(key);
          void this.capture('section', artist, title, S, 0);
          return;
        }
        if (this.hooks.hasTempo?.(key)) return;          // tempofangst + analys finns redan
        void this.capture('tempo', artist, title, this.cfg.tempoS, 0);
      } catch { /* aldrig falla motorn */ }
    }, this.cfg.tempoDelayS * 1000);
  }
  private saveSectionCount(): void {
    if (!this.cfg.sectionCountFile) return;
    try { writeFileSync(this.cfg.sectionCountFile, JSON.stringify({ count: this.sectionCount, at: Date.now() })); } catch { /* raknaren far aldrig falla motorn */ }
  }

  // ── DROPTRIGGER (analysatorns dropCount + manuell begaran) ──────────────────────────────────
  start(): void {
    if (this.pollTimer) return;
    if (this.cfg.sectionS > 0) this.log(`[tempo] langfangst for sektionsanalys PA: ${this.cfg.sectionS} s, ${this.sectionCount}/${this.cfg.sectionMax} tagna`);
    if (!this.enabled) this.log('[tempo] fangster AV - inga fangster till hamtaren');
    this.pollTimer = setInterval(() => this.pollDrop(), this.cfg.dropPollMs);
  }
  stop(): void { if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } }
  /** Ett varv i dropbevakningen (exponerad for simulering). */
  pollDrop(): void {
    try {
      const f = this.hooks.latestFrame(); const manual = this.hooks.takeManual?.() ?? null;
      const fired = !!(f && typeof f.dropCount === 'number' && this.lastDropCount >= 0 && f.dropCount !== this.lastDropCount);
      if (f && typeof f.dropCount === 'number') this.lastDropCount = f.dropCount;
      const playing = this.hooks.isPlaying ? this.hooks.isPlaying() : true;
      if ((fired || manual) && this.lastTrack && playing && this.dropsThisSong < this.cfg.dropMaxPerSong) {
        this.dropsThisSong++;
        void this.capture('drop', this.lastArtist, this.lastTrack, this.cfg.dropPostS, this.cfg.dropPreS);
      }
    } catch { /* aldrig falla motorn */ }
  }

  // ── EN FANGST ────────────────────────────────────────────────────────────────────────────────
  private async capture(kind: 'tempo' | 'drop' | 'section', artist: string | null, title: string, seconds: number, prerollS: number): Promise<void> {
    if ((this.hooks.ready && !this.hooks.ready()) || this.busy) return;
    try {
      if (this.rawActive) return;
      if (!this.enabled) return;
      const key = this.hooks.songKey(artist || '', title);
      const id = kind === 'tempo' ? key : key + (kind === 'drop' ? '#d' : '#s') + Date.now().toString(36);
      const fname = id.replace(/\|/g, '__').replace(/#/g, '_');
      const dir = this.cfg.dir; mkdirSync(dir, { recursive: true });
      const pending = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.events.json'));
      if (pending.includes(fname + '.json') || pending.length >= this.cfg.queueMax) return;
      this.busy = true; this.trackChangeMs = 0;
      this.startRaw(seconds, title, true, prerollS);
      const t0 = Date.now();
      this.log(`[tempo] fangst ${kind}: ${prerollS ? prerollS + ' s fore + ' : ''}${seconds} s @${this.sr / 1000} kHz for "${title}"`);
      const kicks = new Set<number>(); const bright: number[][] = []; const flags: unknown[][] = []; let lastFlag = '';
      const phases: number[][] = []; let lastPhase = 0;
      const tick = setInterval(() => {
        try {
          const now = Date.now(); const f = this.hooks.latestFrame();
          const pct = this.hooks.brightness?.(); if (typeof pct === 'number') bright.push([now, Math.round(pct) / 100]);
          if (f) {
            const fl = `${f.dropCount}|${f.inRiser ? 1 : 0}|${Math.round((f.buildUp ?? 0) * 100)}|${f.breaking ? 1 : 0}|${f.inZone ? 1 : 0}|${f.section ?? ''}|${f.sectionIndex ?? 0}`;
            if (fl !== lastFlag) { lastFlag = fl; flags.push([now, f.dropCount, f.inRiser ? 1 : 0, Math.round((f.buildUp ?? 0) * 100) / 100, f.breaking ? 1 : 0, f.inZone ? 1 : 0, f.section ?? '', f.sectionIndex ?? 0, Math.round((f.repeatSim ?? 0) * 100) / 100, f.repeatAgoMs ?? 0]); }
          }
          if (f && typeof f.beatPhaseMs === 'number' && f.beatPhaseMs > 0 && f.beatPhaseMs !== lastPhase) { lastPhase = f.beatPhaseMs; phases.push([Math.round(f.beatPhaseMs), Math.round((f.beatPhaseConf ?? 0) * 100) / 100, f.bpm ?? 0]); }
          if (bright.length % 50 === 1) for (const k of (this.hooks.recentKicks?.() ?? [])) kicks.add(k);
        } catch { /* loggen far aldrig falla motorn */ }
      }, 100);
      setTimeout(() => {
        clearInterval(tick); this.busy = false;
        try {
          for (const k of (this.hooks.recentKicks?.() ?? [])) kicks.add(k);
          if (kind === 'tempo' && title !== this.lastTrack) { this.takeWav(); return; }   // laten bytte - kasta
          const truncatedAtMs = kind === 'section' && title !== this.lastTrack ? (this.trackChangeMs || Date.now()) : 0;
          const wav = this.takeWav(); if (!wav) return;
          const meta = this.rawMeta() ?? { startWallMs: t0, prerollSamples: 0, rate: this.sr };
          const since = meta.startWallMs - 1000;
          const events = { id, key, kind, artist: artist || '', title, captureStartWallMs: meta.startWallMs, prerollSamples: meta.prerollSamples, rate: this.sr,
            seconds: (wav.length - 44) / 2 / this.sr, beat: this.hooks.beatInfo?.() ?? null, kicks: [...kicks].filter((k) => k >= since).sort((a, b) => a - b),
            pulses: this.hooks.pulses?.(since) ?? [], bright, flags, phases, ...(truncatedAtMs ? { truncatedAtMs } : {}) };
          // Asynkront (en 3-14 MB WAV pa SD-kortet stallar annars event-loopen); index-json SIST sa hamtaren aldrig ser en halv fangst.
          const _t0w = performance.now();
          import('node:fs/promises').then(async (fsp) => {
            await fsp.writeFile(dir + '/' + fname + '.wav', wav);
            await fsp.writeFile(dir + '/' + fname + '.events.json', JSON.stringify(events));
            await fsp.writeFile(dir + '/' + fname + '.json', JSON.stringify({ id, key, kind, artist: artist || '', title, capturedAt: Date.now(), rate: this.sr, seconds: events.seconds, hasEvents: true }));
            this.log(`[tempo] snutt sparad: ${id} (${(wav.length / 1e6).toFixed(1)} MB, ${events.kicks.length} kickar, ${(events.pulses as unknown[]).length ?? 0} pulser, ${bright.length} ljusprov, ko ${pending.length + 1}, ${(performance.now() - _t0w).toFixed(0)} ms async)`);
          }).catch((e) => this.log('[tempo] snutt kunde inte sparas: ' + (e as Error).message));
        } catch (e) { this.log('[tempo] snutt kunde inte sparas: ' + (e as Error).message); }
      }, (seconds + 2) * 1000);
    } catch (e) { this.busy = false; this.log('[tempo] fangst misslyckades: ' + (e as Error).message); }
  }
}
