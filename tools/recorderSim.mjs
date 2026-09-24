/**
 * INSPELARENS SIMULERING (2026-09-24): bevisar att lotus fangar LIKA MANGA snuttar, med SAMMA ljud, efter att
 * fangsten flyttats ut ur index.ts/alsaMic.ts till den egna modulen recorder/recorder.ts.
 *
 * Ett langt ljud spelas hop for hop genom analysatorn (virtuell tid, falska timers). En spellista med latbyten
 * (--track-s sekunder per "lat") driver bada sidor:
 *   GAMMAL: fangstlogiken och ra-bufferten ur main (index.ts runCapture/scheduleSnippet/droppoll + alsaMic
 *           startRawCapture/getRawCaptureWav/forbuffert), overforda rad for rad hit (se OLD nedan).
 *   NY:     den kompilerade Recorder-modulen (dist/recorder/recorder.js) med lotus krokar.
 * Bada far samma rasampel per callback-block (256 sampel), samma Frame, samma latbyten, samma klocka.
 * Utskrift: antal fangster per slag + md5 av varje WAV (gammal/ny) + handelseloggarnas nycklar. Exit 1 vid skillnad.
 *
 *   node tools/recorderSim.mjs --analyser pi/dist/audio-analyser/index.js --recorder pi/dist/recorder/recorder.js
 *        [--secs 1200] [--track-s 150] [--section-s 0] <wav> [<wav> ...]
 */
import { readFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ANALYSER = opt('--analyser'), RECORDER = opt('--recorder');
const SECS = Number(opt('--secs', 1200)), TRACK_S = Number(opt('--track-s', 150)), SECTION_S = Number(opt('--section-s', 0));
const valued = new Set(['--analyser', '--recorder', '--secs', '--track-s', '--section-s']);
const wavs = argv.filter((a, i) => a.endsWith('.wav') && !valued.has(argv[i - 1]));

// ── FALSK KLOCKA + TIMERS (allt drivs av ljudtiden) ──────────────────────────────────────────────
const EPOCH = 1700000000000; let now = EPOCH;
const timers = []; let tid = 1;
Date.now = () => Math.floor(now);
const realPerf = performance.now.bind(performance);
globalThis.setTimeout = (fn, ms) => { const t = { id: tid++, at: now + (ms || 0), fn, every: 0 }; timers.push(t); return { ...t, unref() {} }; };
globalThis.setInterval = (fn, ms) => { const t = { id: tid++, at: now + ms, fn, every: ms }; timers.push(t); return t.id; };
globalThis.clearInterval = (h) => { const id = typeof h === 'object' ? h?.id : h; const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
globalThis.clearTimeout = globalThis.clearInterval;
function runTimers() {
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0]; if (!t || t.at > now) return;
    if (t.every) t.at += t.every; else timers.shift();
    t.fn();
  }
}

const { createAnalyser } = await import(pathToFileURL(ANALYSER).href);
const _log = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[')) _log(...a); };   // analysatorns [dropfire]-rader tyst
const { Recorder } = await import(pathToFileURL(RECORDER).href);

// ── Delade kallor (samma for bada sidor) ─────────────────────────────────────────────────────────
let latestFrame = null; const kickRing = [];
const songKey = (a, t) => (a + '|' + t).toLowerCase().replace(/[^a-z0-9|]+/g, '');
const brightness = () => 50;

// ── OLD: fangsten som den sag ut i main (alsaMic.ts + index.ts), overford ──────────────────────────
function makeOld(dir) {
  const SAMPLE_RATE = 48000, RAW_RATE = 16000, RAW_DECIM = 3, RAW_MAX_SECONDS = 420, PRE_SECONDS = 15, PRE_LEN = SAMPLE_RATE * PRE_SECONDS;
  let rawCaptureActive = false, rawBuf = null, rawLen = 0, rawTarget = 0, rawRate = RAW_RATE, rawDecimN = RAW_DECIM;
  let preBuf = null, prePos = 0, preFilled = 0, rawStartWallMs = 0, rawPrerollSamples = 0, rawLabel = '', rawDecim = 0, rawAcc = 0;
  const enablePreroll = (on) => { if (on) { if (!preBuf) preBuf = new Int16Array(PRE_LEN); } else { preBuf = null; prePos = 0; preFilled = 0; } };
  const getRawCaptureMeta = () => ({ startWallMs: rawStartWallMs, prerollSamples: rawPrerollSamples, rate: rawRate });
  function startRawCapture(seconds, label, fullRate = false, prerollS = 0) {
    const sec = Math.max(1, Math.min(fullRate ? 150 : RAW_MAX_SECONDS, Math.round(seconds)));
    rawLabel = (label ?? '').slice(0, 120);
    rawRate = fullRate ? SAMPLE_RATE : RAW_RATE; rawDecimN = fullRate ? 1 : RAW_DECIM;
    const pre = (fullRate && prerollS > 0 && preBuf) ? Math.min(preFilled, SAMPLE_RATE * Math.min(PRE_SECONDS, Math.round(prerollS))) : 0;
    rawTarget = rawRate * sec + pre; rawDecim = 0; rawAcc = 0;
    if (!rawBuf || rawBuf.length < rawTarget) rawBuf = new Int16Array(rawTarget);
    rawLen = 0; rawPrerollSamples = pre; rawStartWallMs = 0;
    if (pre > 0 && preBuf) {
      let src = prePos - pre; if (src < 0) src += PRE_LEN;
      const n1 = Math.min(pre, PRE_LEN - src);
      rawBuf.set(preBuf.subarray(src, src + n1), 0);
      if (n1 < pre) rawBuf.set(preBuf.subarray(0, pre - n1), n1);
      rawLen = pre; rawStartWallMs = Date.now() - (pre / SAMPLE_RATE) * 1000;
    }
    rawCaptureActive = true; return sec;
  }
  const getRawCaptureStatus = () => ({ active: rawCaptureActive, seconds: rawLen / rawRate, done: rawLen >= rawTarget && rawTarget > 0, label: rawLabel });
  function getRawCaptureWav() {
    if (!rawBuf || rawLen < rawRate) return null;
    rawCaptureActive = false;
    const dataBytes = rawLen * 2; const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rawRate, 24); buf.writeUInt32LE(rawRate * 2, 28); buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
    Buffer.from(rawBuf.buffer, rawBuf.byteOffset, dataBytes).copy(buf, 44);
    if (rawBuf.length > SAMPLE_RATE * 31) rawBuf = null;
    rawLen = 0; return buf;
  }
  // per-sampel-vagen i onAudioData (samma for S16/S32)
  function pushBlock(block, n) {
    for (let i = 0; i < n; i++) {
      const rawPre = block[i];
      if (preBuf) { let pv = rawPre * 32767; if (pv > 32767) pv = 32767; else if (pv < -32767) pv = -32767; preBuf[prePos] = pv; if (++prePos >= PRE_LEN) prePos = 0; if (preFilled < PRE_LEN) preFilled++; }
      if (rawCaptureActive && rawBuf && rawLen < rawTarget) {
        if (rawStartWallMs === 0) rawStartWallMs = Date.now();
        rawAcc += rawPre;
        if (++rawDecim >= rawDecimN) { let r = (rawAcc / rawDecimN) * 32767; if (r > 32767) r = 32767; else if (r < -32768) r = -32768; rawBuf[rawLen++] = r; rawDecim = 0; rawAcc = 0; if (rawLen >= rawTarget) rawCaptureActive = false; }
      }
    }
  }
  // index.ts (main): noteTrackName-delen, runCapture, scheduleSnippet, droppollen
  let lastTrackName = null, lastArtist = null, _captureBusy = false, _dropCapturesThisSong = 0, _lastDropCount = -1, _captureTrackChangeMs = 0, _captureEnabled = true, _sectionCaptures = 0;
  const written = [];
  const runCapture = async (kind, artist, title, seconds, prerollS) => {
    if (_captureBusy) return;
    try {
      const st = getRawCaptureStatus(); if (st?.active) return;
      if (!_captureEnabled) return;
      const key = songKey(artist || '', title);
      const id = kind === 'tempo' ? key : key + (kind === 'drop' ? '#d' : '#s') + Date.now().toString(36);
      const fname = id.replace(/\|/g, '__').replace(/#/g, '_');
      mkdirSync(dir, { recursive: true });
      const pending = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.events.json'));
      if (pending.includes(fname + '.json') || pending.length >= 30) return;
      _captureBusy = true; _captureTrackChangeMs = 0;
      startRawCapture(seconds, title, true, prerollS);
      const t0 = Date.now();
      const kicks = new Set(); const bright = []; const flags = []; let lastFlag = ''; const phases = []; let lastPhase = 0;
      const tick = setInterval(() => {
        const nw = Date.now(); const f = latestFrame; const pct = brightness(); if (typeof pct === 'number') bright.push([nw, Math.round(pct) / 100]);
        if (f) { const fl = `${f.dropCount}|${f.inRiser ? 1 : 0}|${Math.round((f.buildUp ?? 0) * 100)}|${f.breaking ? 1 : 0}|${f.inZone ? 1 : 0}|${f.section ?? ''}|${f.sectionIndex ?? 0}`;
          if (fl !== lastFlag) { lastFlag = fl; flags.push([nw, f.dropCount, f.inRiser ? 1 : 0, Math.round((f.buildUp ?? 0) * 100) / 100, f.breaking ? 1 : 0, f.inZone ? 1 : 0, f.section ?? '', f.sectionIndex ?? 0, Math.round((f.repeatSim ?? 0) * 100) / 100, f.repeatAgoMs ?? 0]); } }
        if (f && typeof f.beatPhaseMs === 'number' && f.beatPhaseMs > 0 && f.beatPhaseMs !== lastPhase) { lastPhase = f.beatPhaseMs; phases.push([Math.round(f.beatPhaseMs), Math.round((f.beatPhaseConf ?? 0) * 100) / 100, f.bpm ?? 0]); }
        if (bright.length % 50 === 1) for (const k of kickRing) kicks.add(k);
      }, 100);
      setTimeout(() => {
        clearInterval(tick); _captureBusy = false;
        for (const k of kickRing) kicks.add(k);
        if (kind === 'tempo' && title !== lastTrackName) { getRawCaptureWav(); return; }
        const truncatedAtMs = kind === 'section' && title !== lastTrackName ? (_captureTrackChangeMs || Date.now()) : 0;
        const wav = getRawCaptureWav(); if (!wav) return;
        const meta = getRawCaptureMeta() ?? { startWallMs: t0, prerollSamples: 0, rate: 48000 };
        const since = meta.startWallMs - 1000;
        const events = { id, key, kind, artist: artist || '', title, captureStartWallMs: meta.startWallMs, prerollSamples: meta.prerollSamples, rate: 48000,
          seconds: (wav.length - 44) / 2 / 48000, beat: null, kicks: [...kicks].filter((k) => k >= since).sort((a, b) => a - b), pulses: [], bright, flags, phases, ...(truncatedAtMs ? { truncatedAtMs } : {}) };
        written.push({ fname, kind, wav, events });
      }, (seconds + 2) * 1000);
    } catch (e) { _captureBusy = false; }
  };
  return {
    enablePreroll, pushBlock, written,
    noteTrack(name, artist) { if (artist !== undefined) lastArtist = artist; if (name === lastTrackName) return; if (_captureBusy && !_captureTrackChangeMs) _captureTrackChangeMs = Date.now(); lastTrackName = name; },
    trackChanged(artist, title) {
      _dropCapturesThisSong = 0;
      setTimeout(() => {
        if (title !== lastTrackName) return;
        const row = null;
        if (SECTION_S > 0 && !(row && row.secAt) && _sectionCaptures < 40 && !_captureBusy) { _sectionCaptures++; void runCapture('section', artist, title, SECTION_S, 0); return; }
        if (row && row.bpm > 0 && row.pc) return;
        void runCapture('tempo', artist, title, 30, 0);
      }, 10000);
    },
    startPoll() {
      setInterval(() => {
        const f = latestFrame; const manual = null;
        const fired = !!(f && typeof f.dropCount === 'number' && _lastDropCount >= 0 && f.dropCount !== _lastDropCount);
        if (f && typeof f.dropCount === 'number') _lastDropCount = f.dropCount;
        if ((fired || manual) && lastTrackName && true && _dropCapturesThisSong < 2) { _dropCapturesThisSong++; void runCapture('drop', lastArtist, lastTrackName, 15, 15); }
      }, 250);
    },
  };
}

// ── NEW: modulen ─────────────────────────────────────────────────────────────────────────────────
function makeNew(dir) {
  const rec = new Recorder({ dir, sampleRate: 48000, enabled: true, sectionS: SECTION_S, sectionMax: 40 }, {
    latestFrame: () => latestFrame, recentKicks: () => kickRing, brightness, pulses: () => [], beatInfo: () => null,
    isPlaying: () => true, ready: () => true, songKey, hasTempo: () => false, hasSection: () => false, markSection: () => {},
    sectionBlocked: () => false, takeManual: () => null, log: () => {},
  });
  return rec;
}

function readWav(path) {
  const b = readFileSync(path); const ch = b.readUInt16LE(22);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off + 8 <= b.length) { const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4); if (id === 'data') { dataOff = off + 8; dataLen = len > 0 ? Math.min(len, b.length - dataOff) : b.length - dataOff; break; } off += 8 + len + (len & 1); }
  const n = Math.floor(dataLen / 2 / ch); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2); y[i] = s / ch / 32768; }
  return y;
}

// Ett langt ljud: filerna efter varandra
const parts = wavs.map(readWav); const total = parts.reduce((a, p) => a + p.length, 0);
const y = new Float32Array(total); { let o = 0; for (const p of parts) { y.set(p, o); o += p.length; } }
const N = Math.min(y.length, Math.floor(SECS * 48000));

const dirNew = mkdtempSync(join(tmpdir(), 'recsim-new-'));
const OLD = makeOld(join(tmpdir(), 'recsim-old-unused')); const NEW = makeNew(dirNew);
OLD.enablePreroll(true); NEW.enablePreroll(true); OLD.startPoll(); NEW.start();
const an = createAnalyser({ sampleRate: 48000, hopSize: 128, autoGainTarget: 0.75, maxGain: 200, noiseFloor: 0.0015, onsetEnhancements: false });
an.setGainLock(false);
const BLOCK = 256, HOP = 128; const block = new Float32Array(BLOCK); const hop = new Float32Array(HOP);
let hops = 0, track = -1, lastKick = 0;
for (let i = 0; i + BLOCK <= N; i += BLOCK) {
  const tS = i / 48000;
  const tr = Math.floor(tS / TRACK_S);
  if (tr !== track) {   // latbyte: namn direkt, debouncat byte 1,5 s senare (som noteTrackName)
    track = tr; const name = 'Lat ' + tr, artist = 'Sim';
    OLD.noteTrack(name, artist); NEW.noteTrack(name, artist);
    setTimeout(() => { OLD.trackChanged(artist, name); NEW.trackChanged(artist, name); }, 1500);
  }
  block.set(y.subarray(i, i + BLOCK));
  OLD.pushBlock(block, BLOCK); NEW.push(block, BLOCK);
  for (let h = 0; h < BLOCK; h += HOP) {
    hop.set(block.subarray(h, h + HOP));
    const ms = hops * HOP / 48 ; an.setAudioClockMs(ms); if (hops === 0) an.setVirtualClock(0); else an.advanceVirtualClock(ms);
    latestFrame = an.process(hop); hops++;
    if (latestFrame.kickAtMs > 0 && latestFrame.kickAtMs !== lastKick) { lastKick = latestFrame.kickAtMs; kickRing.push(lastKick); if (kickRing.length > 64) kickRing.shift(); }
  }
  now = EPOCH + ((i + BLOCK) / 48000) * 1000;
  runTimers();
}
now += 60000; runTimers();
const tick = () => new Promise((r) => setImmediate(r));
for (let k = 0; k < 2000; k++) await tick();   // nya sidans asynkrona filskrivningar (fs/promises)
const md5 = (b) => createHash('md5').update(b).digest('hex').slice(0, 12);
const oldRows = OLD.written.map((w) => ({ id: w.fname, kind: w.kind, md5: md5(w.wav), ev: JSON.stringify({ ...w.events, id: undefined }) }));
for (let k = 0; k < 2000 && readdirSync(dirNew).filter((f) => f.endsWith('.json') && !f.endsWith('.events.json')).length < oldRows.length; k++) await tick();
const newFiles = readdirSync(dirNew).filter((f) => f.endsWith('.json') && !f.endsWith('.events.json')).map((f) => f.replace(/\.json$/, '')).sort((a, b) => a.localeCompare(b));
const newRows = newFiles.map((id) => { const ev = JSON.parse(readFileSync(join(dirNew, id + '.events.json'), 'utf8')); return { id, kind: ev.kind, md5: md5(readFileSync(join(dirNew, id + '.wav'))), ev: JSON.stringify({ ...ev, id: undefined }) }; });
const byKind = (rows) => rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
console.log(`simulerat ${(N / 48000).toFixed(0)} s, ${track + 1} latar a ${TRACK_S} s, sektionsfangst ${SECTION_S} s`);
console.log(`GAMMAL: ${oldRows.length} fangster ${JSON.stringify(byKind(oldRows))}`);
console.log(`NY:     ${newRows.length} fangster ${JSON.stringify(byKind(newRows))}`);
const oldSorted = [...oldRows].sort((a, b) => a.id.localeCompare(b.id));
let diff = 0;
for (let k = 0; k < Math.max(oldSorted.length, newRows.length); k++) {
  const o = oldSorted[k], n = newRows[k];
  const same = o && n && o.id === n.id && o.md5 === n.md5 && o.ev === n.ev;
  if (!same) diff++;
  console.log(`  ${same ? 'lika ' : 'OLIKA'} ${o ? `${o.id} ${o.kind} wav ${o.md5}` : '-'}  |  ${n ? `${n.id} ${n.kind} wav ${n.md5}` : '-'}`);
}
console.log(`SUMMA: ${diff === 0 ? 'IDENTISKA' : diff + ' avvikelser'} (id, WAV-md5 och handelselogg per fangst)`);
rmSync(dirNew, { recursive: true, force: true });
process.exit(diff ? 1 : 0);
