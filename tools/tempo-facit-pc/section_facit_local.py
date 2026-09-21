"""LOKALT SEKTIONSFACIT (2026-09-22, natt) - utan moln. Samma schema som section_facit.py:s 'derived'
([{start,end,label,db,onsetPerS,score,tier}], tier high/mid/low/intro ur derive() sa definitionen ar identisk), sparat som
result.analysis.sections.derived_local i corpus/<id>.json, och - nar molnets 'derived' saknas (dygnstaket natt, ingen nyckel,
molnfel) - aven som 'derived' med source:'local' sa banken (bench.mjs) kan doma sektioner.

Granser (strukturell segmentering ur ljudet, librosa):
  1. slag: Beat This!-slagen ur json (analysis.sections.beatsS > beatthis.beatsS > result.beatsS nar beatsSource=beatthis),
     annars librosa beat_track med TIDSVARIERANDE tempo (tempogram per ram, medianfiltrerat ~12 s) sa 20 min-mixar med
     tempobyten fungerar. Nedslag: Beat This!-downbeats om de finns, annars taktfasen (0..3) som maximerar basonset +
     kromaandring pa slagen, skattad lokalt (+-16 slag) runt varje kandidatgrans.
  2. sardrag @ 22,05 kHz, hop 512: MFCC 1-19 (timbre), chroma_cqt (harmonik), log-RMS + basonsetstyrka (energi);
     slagsynkade (median per slag), standardiserade, viktade (timbre 1, kroma 0,7, energi 1), + minne 1 slag.
  3. sjalvlikhet (cosinus) -> Foote-novelty med schackbradskarna (gaussisk) pa tva skalor (halvbredd 8 och 16 slag = 2 och 4
     takter), summerade efter normering. Toppar: lokala maxima over adaptiv troskel (medel + 0,6*std i +-64 slag och >= 25 % av
     globala max), giriga i fallande ordning med minsta avstand 8 s (--min-seg).
  4. snappning: varje topp flyttas till narmaste taktstreck (4 slag fran nedslaget) om <= 2 slag bort. Segment < 8 s slas ihop.
Validering utan facit (per fil, skrivs i sections.local.validation):
  phrase4/phrase8 = andel granser vars avstand i slag till foregaende grans (forsta: till forsta nedslaget) ligger inom +-1 slag
  fran en multipel av 16/32 slag (4/8 takter); stability = andel granser som aterfinns inom +-1 s nar starten forskjuts 0,5 s,
  tierAgree = andel sekunder med samma tier vid forskjutningen; nSeg, segMedianS, highShare, per3min.
Kor:  .venv\\Scripts\\python.exe section_facit_local.py [--force] [--min-s 60] [--only <delstrang>]           (korpusen)
      .venv\\Scripts\\python.exe section_facit_local.py --wav <fil.wav> [...] --out <katalog>                  (fristaende)
"""
import glob, json, os, sys, time
import numpy as np, soundfile as sf, librosa, scipy.ndimage, scipy.signal
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from section_facit import derive          # samma tier-definition (dB + basonset-rang) som molnfacitet

SR = 22050; HOP = 512
MIN_SEG_S = float(os.environ.get('LOTUS_SECTION_MIN_SEG_S', '8'))
KERNEL = tuple(int(x) for x in os.environ.get('LOTUS_SECTION_KERNEL', '8,16').split(','))   # halvbredder i slag for den breda noveltyn


# ───────────────────────────── slag ─────────────────────────────

def beats_from_json(m):
    """Beat This!-slag (och nedslag) ur korpusens json, annars None. Ordning: molnets sektionspost, beatthis-posten, tjanstens
    slutliga slag (result.beatsS) nar de ar Beat This!-gridet."""
    a = ((m.get('result') or {}).get('analysis') or {})
    sec = a.get('sections') or {}
    if isinstance(sec, dict) and len(sec.get('beatsS') or []) >= 8:
        return [float(b) for b in sec['beatsS']], [float(d) for d in (sec.get('downbeatsS') or [])], 'allin1'
    bt = m.get('beatthis') or {}
    if len(bt.get('beatsS') or []) >= 8:
        return [float(b) for b in bt['beatsS']], [float(d) for d in (bt.get('downbeatsS') or [])], 'beatthis'
    r = m.get('result') or {}
    if r.get('beatsSource') == 'beatthis' and len(r.get('beatsS') or []) >= 8:
        return [float(b) for b in r['beatsS']], [float(d) for d in (r.get('btDownbeatsS') or [])], 'beatthis-grid'
    return None


def beats_librosa(y22, oenv):
    """Slag med tidsvarierande tempo: tempogram -> tempo per ram -> medianfilter (~12 s) -> beat_track(bpm=vektor)."""
    tempo = librosa.feature.tempo(onset_envelope=oenv, sr=SR, hop_length=HOP, aggregate=None, ac_size=8.0, start_bpm=120, std_bpm=1.5, max_tempo=200)
    k = int(12 * SR / HOP) | 1
    tempo = scipy.ndimage.median_filter(tempo, size=k, mode='nearest')
    tempo = np.clip(tempo, 60, 200)
    _, bf = librosa.beat.beat_track(onset_envelope=oenv, sr=SR, hop_length=HOP, bpm=tempo, trim=False, units='frames')
    return librosa.frames_to_time(bf, sr=SR, hop_length=HOP)


def bar_phase(beats_idx_near, bass_at, chroma_change_at):
    """Taktfas 0..3: vilken slagrest (mod 4) som bar mest basonset + kromaandring inom de givna slagindexen."""
    score = np.zeros(4)
    for i in beats_idx_near:
        score[i % 4] += bass_at[i] + chroma_change_at[i]
    return int(np.argmax(score))


# ───────────────────────────── sardrag + novelty ─────────────────────────────

def features(y22, beat_frames):
    """Slagsynkade sardrag (kolumn per slag) och per-slag hjalpmatt (basonset, kromaandring)."""
    S = librosa.feature.melspectrogram(y=y22, sr=SR, hop_length=HOP, n_fft=2048, n_mels=64, fmax=8000)
    logS = librosa.power_to_db(S, ref=np.max)
    mfcc = librosa.feature.mfcc(S=logS, n_mfcc=20)[1:]
    chroma = librosa.feature.chroma_cqt(y=y22, sr=SR, hop_length=HOP, bins_per_octave=36)
    rms = librosa.feature.rms(y=y22, frame_length=2048, hop_length=HOP)[0]
    logrms = 20 * np.log10(rms + 1e-6)
    bass = librosa.onset.onset_strength(S=librosa.power_to_db(librosa.feature.melspectrogram(y=y22, sr=SR, hop_length=HOP, n_mels=12, fmax=220), ref=np.max))
    n = min(mfcc.shape[1], chroma.shape[1], len(logrms), len(bass))
    bf = np.clip(beat_frames, 0, n - 1)
    bf = np.unique(np.concatenate([[0], bf, [n]]))
    sync = lambda X: librosa.util.sync(X[..., :n], bf, aggregate=np.median)
    Fm, Fc, Fr = sync(mfcc), sync(chroma), sync(logrms[None, :])
    Fb = librosa.util.sync(bass[None, :n], bf, aggregate=np.max)
    z = lambda X: (X - X.mean(axis=1, keepdims=True)) / (X.std(axis=1, keepdims=True) + 1e-6)
    X = np.vstack([z(Fm) * 1.0 / np.sqrt(Fm.shape[0]), z(Fc) * 0.7 / np.sqrt(Fc.shape[0]), z(Fr) * 1.0, z(Fb) * 0.5])
    X = np.vstack([X, np.roll(X, 1, axis=1) * 0.5])           # minne 1 slag
    cchange = np.r_[0, np.linalg.norm(np.diff(z(Fc), axis=1), axis=0)]
    return X, Fb[0], cchange, bf


def foote_novelty(X, half_widths=(8, 16)):
    Xn = X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    R = Xn.T @ Xn
    N = R.shape[0]; nov = np.zeros(N)
    for L in half_widths:
        L = min(L, max(2, N // 4))
        g = scipy.signal.windows.gaussian(2 * L, std=L / 2.0)
        sign = np.r_[-np.ones(L), np.ones(L)]
        K = np.outer(g * sign, g * sign)
        Rp = np.pad(R, L, mode='edge')
        v = np.zeros(N)
        for i in range(N):
            v[i] = np.sum(Rp[i:i + 2 * L, i:i + 2 * L] * K)
        v = np.maximum(v, 0); v[:L] = 0; v[N - L:] = 0; v /= (v.max() + 1e-9)     # kanterna (utfyllnad) ar ingen grans
        nov += v
    return nov / len(half_widths)


def pick_peaks(nov, min_dist_beats):
    """Lokala maxima over adaptiv troskel, giriga i fallande ordning, minsta avstand min_dist_beats."""
    N = len(nov)
    if N < 4: return []
    loc_mean = scipy.ndimage.uniform_filter1d(nov, size=129, mode='nearest')
    loc_std = np.sqrt(np.maximum(scipy.ndimage.uniform_filter1d(nov ** 2, size=129, mode='nearest') - loc_mean ** 2, 0))
    thr = np.maximum(loc_mean + 0.6 * loc_std, 0.25 * nov.max())
    cand = [i for i in range(1, N - 1) if nov[i] >= nov[i - 1] and nov[i] > nov[i + 1] and nov[i] > thr[i]]
    cand.sort(key=lambda i: -nov[i]); chosen = []
    for i in cand:
        if all(abs(i - j) >= min_dist_beats for j in chosen): chosen.append(i)
    return sorted(chosen)


# ───────────────────────────── segmentering ─────────────────────────────

def segment(y, sr, beats=None, downbeats=None, min_seg_s=MIN_SEG_S):
    """-> {'segments': [{start,end,label}], 'beatsS', 'beatsSource', 'bpm', 'rawBoundsS', 'secs'}"""
    t0 = time.time()
    y22 = librosa.resample(y, orig_sr=sr, target_sr=SR, res_type='polyphase') if sr != SR else y
    dur = len(y22) / SR
    oenv = librosa.onset.onset_strength(y=y22, sr=SR, hop_length=HOP)
    src = 'json'
    if beats is None or len(beats) < 8:
        beats = beats_librosa(y22, oenv); src = 'librosa'; downbeats = None
    beats = np.asarray(sorted(b for b in beats if 0 <= b < dur), dtype=float)
    if len(beats) < 8: return None
    per = float(np.median(np.diff(beats)))
    bframes = librosa.time_to_frames(beats, sr=SR, hop_length=HOP)
    X, bass_at, cchange, bf = features(y22, bframes)
    # kolumn k i X = intervallet [bf[k], bf[k+1]); slag k (beats[k]) startar kolumnen med samma index efter unique/pad
    nov = foote_novelty(X, KERNEL)
    min_dist = max(2, int(np.ceil(min_seg_s / per)))
    peaks = pick_peaks(nov, min_dist)
    fine = foote_novelty(X, half_widths=(4,))                               # smal karna placerar gransen (bred karna valjer den)
    peaks = sorted(set(int(p - 3 + np.argmax(fine[max(0, p - 3):p + 4])) if p >= 3 else p for p in peaks))
    col_t = librosa.frames_to_time(bf[:-1], sr=SR, hop_length=HOP)          # kolumn p borjar vid bf[p]
    beat_col = np.searchsorted(bf, np.clip(bframes, 0, bf[-1] - 1))         # slag k -> kolumn
    bass_b = _pad(bass_at, len(bf))[np.clip(beat_col, 0, len(bass_at) - 1)]; cch_b = _pad(cchange, len(bf))[np.clip(beat_col, 0, len(cchange) - 1)]
    peaks = [p for p in peaks if 2.0 <= col_t[p] <= dur - 2.0]
    raw = [float(col_t[p]) for p in peaks]
    # nedslag: Beat This! eller lokal taktfas
    if downbeats is not None and len(downbeats) >= 2:
        db_idx = set(int(np.argmin(np.abs(beats - d))) for d in downbeats)
        def is_bar(k): return k in db_idx
    else:
        def is_bar(k):
            lo, hi = max(0, k - 16), min(len(beats), k + 17)
            return (k - bar_phase(range(lo, hi), bass_b, cch_b)) % 4 == 0
    snapped = []
    for p in peaks:
        k = int(np.argmin(np.abs(beats - col_t[p]))) if p < len(col_t) else len(beats) - 1
        best = None
        for d in range(-2, 3):
            j = k + d
            if 0 <= j < len(beats) and is_bar(j) and (best is None or abs(d) < abs(best - k)): best = j
        snapped.append(float(beats[best if best is not None else k]))
    bounds = [0.0] + sorted(set(round(b, 3) for b in snapped if b > 1.0)) + [round(dur, 3)]
    # sla ihop segment < min_seg_s
    merged = [bounds[0]]
    for b in bounds[1:]:
        if b - merged[-1] < min_seg_s:
            if b == bounds[-1]: merged[-1] = b
            continue
        merged.append(b)
    if merged[-1] != bounds[-1]: merged.append(bounds[-1])
    segs = [{'start': round(a, 2), 'end': round(b, 2), 'label': 'seg'} for a, b in zip(merged, merged[1:])]
    return {'segments': segs, 'beatsS': [round(float(b), 3) for b in beats], 'beatsSource': src, 'bpm': round(60 / per, 1),
            'rawBoundsS': [round(b, 2) for b in raw], 'secs': round(time.time() - t0, 1)}


def _pad(v, n):
    v = np.asarray(v, dtype=float)
    return np.r_[v, np.zeros(max(0, n - len(v)))][:n]


# ───────────────────────────── validering ─────────────────────────────

def phrase_share(bounds, beats, downbeats, mod, tol=1.0):
    """Andel granser (utom 0 och slutet) vars avstand till foregaende grans (forsta: forsta nedslaget) ar inom +-tol slag fran en
    multipel av mod slag. TIDSBASERAT: avstand / lokal slagperiod (median av 32 intervall runt gransen) - slagraknandet
    forstors av enstaka hopp i librosas slag (7 % av intervallen pa pop_ladan), tiden gor det inte."""
    beats = np.asarray(beats); inner = list(bounds[1:-1])
    if not inner or len(beats) < 8: return None
    iv = np.diff(beats)
    def per_at(t):
        k = int(np.argmin(np.abs(beats - t))); lo, hi = max(0, k - 16), min(len(iv), k + 16)
        return float(np.median(iv[lo:hi])) if hi > lo else float(np.median(iv))
    prev = float(downbeats[0]) if downbeats else float(beats[0]); ok = 0
    for b in inner:
        n = (b - prev) / per_at(b); r = n % mod
        if r <= tol or r >= mod - tol: ok += 1
        prev = b
    return round(ok / len(inner), 2)


def tier_at(rows, t):
    for r in rows:
        if r['start'] <= t < r['end']: return r['tier']
    return None


def validate(y, sr, res, rows, beats_json=None, downbeats=None):
    segs = res['segments']; bounds = [segs[0]['start']] + [s['end'] for s in segs]
    dur = len(y) / sr
    v = {'nSeg': len(segs), 'segMedianS': round(float(np.median([s['end'] - s['start'] for s in segs])), 1),
         'segMinS': round(min(s['end'] - s['start'] for s in segs), 1), 'segMaxS': round(max(s['end'] - s['start'] for s in segs), 1),
         'per3min': round(len(segs) / max(1e-6, dur / 180), 1),
         'phrase4': phrase_share(bounds, res['beatsS'], downbeats, 16), 'phrase8': phrase_share(bounds, res['beatsS'], downbeats, 32),
         'phrase4raw': phrase_share([0.0] + res['rawBoundsS'] + [dur], res['beatsS'], downbeats, 16)}
    if rows:
        tot = sum(r['end'] - r['start'] for r in rows)
        v['highShare'] = round(sum(r['end'] - r['start'] for r in rows if r['tier'] == 'high') / max(1e-6, tot), 2)
        v['tiers'] = {k: sum(1 for r in rows if r['tier'] == k) for k in ('intro', 'high', 'mid', 'low')}
    # stabilitet: 0,5 s forskjuten start
    off = 0.5; y2 = y[int(off * sr):]
    b2 = [b - off for b in beats_json if b - off >= 0] if beats_json else None
    d2 = [d - off for d in downbeats if d - off >= 0] if downbeats else None
    r2 = segment(y2, sr, b2, d2)
    if r2:
        inner1 = bounds[1:-1]; inner2 = [s['end'] + off for s in r2['segments'][:-1]]
        hit = sum(1 for b in inner1 if any(abs(b - c) <= 1.0 for c in inner2))
        v['stability'] = round(hit / len(inner1), 2) if inner1 else None
        v['stabilityN'] = f'{len(inner1)}/{len(inner2)}'
        rows2 = derive(y2, sr, r2['segments'])
        if rows and rows2:
            ts = np.arange(1.0, dur - 1.0, 1.0)
            same = sum(1 for t in ts if tier_at(rows, t) == tier_at(rows2, t - off))
            v['tierAgree'] = round(same / len(ts), 2)
    return v


# ───────────────────────────── in/ut ─────────────────────────────

def read_wav(path):
    """soundfile, men strommade inspelningar (pop_ladan/megamix: datachunk-langd 0 i headern) lases ratt ur PCM 16-bit."""
    info = sf.info(path)
    if info.frames > 0:
        y, sr = sf.read(path, dtype='float32'); return (y.mean(axis=1) if y.ndim > 1 else y), sr
    import struct
    with open(path, 'rb') as fh: hdr = fh.read(44); raw = fh.read()
    ch, sr, bits = struct.unpack('<H', hdr[22:24])[0], struct.unpack('<I', hdr[24:28])[0], struct.unpack('<H', hdr[34:36])[0]
    if bits != 16: raise ValueError(f'{path}: {bits} bitar stods inte i raw-lasning')
    y = np.frombuffer(raw[: len(raw) - len(raw) % (2 * ch)], dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1: y = y.reshape(-1, ch).mean(axis=1)
    return y, sr


def run_file(wav, m=None, min_seg_s=MIN_SEG_S, do_validate=True):
    """Segmentera + tier-rangordna en WAV. m = korpusens json (for Beat This!-slag). -> (rows, local) eller (None, None)."""
    y, sr = read_wav(wav)
    bj = beats_from_json(m) if m else None
    beats, downs, bsrc = bj if bj else (None, None, None)
    res = segment(y, sr, beats, downs, min_seg_s)
    if not res: return None, None
    if bsrc: res['beatsSource'] = bsrc
    rows = derive(y, sr, res['segments'])
    if rows:
        for r in rows: r['source'] = 'local'
    local = {'method': 'foote-ssm-mfcc-chroma-beatsync', 'beatsSource': res['beatsSource'], 'bpm': res['bpm'], 'segments': res['segments'],
             'rawBoundsS': res['rawBoundsS'], 'secs': res['secs'], 'at': int(time.time())}
    if do_validate and rows:
        t0 = time.time(); local['validation'] = validate(y, sr, res, rows, beats, downs); local['validation']['secsTotal'] = round(res['secs'] + time.time() - t0, 1)
    return rows, local


def apply_to_json(m, rows, local):
    """Skriver derived_local (+ derived nar molnets saknas) i korpus-json:ens result.analysis.sections."""
    r = m.setdefault('result', {}); a = r.setdefault('analysis', {})
    sec = a.get('sections')
    if not isinstance(sec, dict): sec = {}; a['sections'] = sec
    sec['derived_local'] = rows; sec['local'] = local
    if not sec.get('derived') or sec.get('derivedSource') == 'local':
        sec['derived'] = rows; sec['derivedSource'] = 'local'
    return m


def backfill_corpus(corpus_dir=None, force=False, min_s=60.0, only='', verbose=True):
    """Alla korpusfiler (>= min_s) utan derived_local -> lokalt facit. -> antal nya."""
    corpus_dir = corpus_dir or os.path.join(HERE, 'corpus'); n = 0
    for f in sorted(glob.glob(os.path.join(corpus_dir, '*.json'))):
        wav = f[:-5] + '.wav'
        if not os.path.exists(wav) or (only and only not in os.path.basename(f).lower()): continue
        try: m = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        sec = (((m.get('result') or {}).get('analysis') or {}).get('sections') or {})
        if isinstance(sec, dict) and sec.get('derived_local') and not force: continue
        if (m.get('result') or {}).get('method') == 'brus': continue
        try:
            info = sf.info(wav)
            if 0 < info.frames / info.samplerate < min_s: continue
            rows, local = run_file(wav, m)
        except Exception as e:
            if verbose: print(f'  FEL {os.path.basename(f)[:40]}: {str(e)[:120]}', flush=True)
            continue
        if not rows: continue
        apply_to_json(m, rows, local)
        json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False); n += 1
        if verbose: print(f"  {os.path.basename(f)[:40]:40} {fmt(rows)}  {json.dumps(local.get('validation'))}", flush=True)
    return n


def fmt(rows):
    return ' | '.join(f"{r['start']:.0f}-{r['end']:.0f} {r['tier']}" for r in rows)


def compare_cloud(corpus_dir=None):
    """Lokalt mot molnet dar bada finns: gransrecall/precision (+-3 s, som bankens gransfel) och tier-overensstammelse per
    sekund (molnets derived raknas om ur segmenten med derive() om det saknas)."""
    corpus_dir = corpus_dir or os.path.join(HERE, 'corpus'); out = []
    for f in sorted(glob.glob(os.path.join(corpus_dir, '*.json'))):
        m = json.load(open(f, encoding='utf-8')); sec = (((m.get('result') or {}).get('analysis') or {}).get('sections') or {})
        if not isinstance(sec, dict) or not sec.get('segments') or not sec.get('derived_local') or not os.path.exists(f[:-5] + '.wav'): continue
        y, sr = read_wav(f[:-5] + '.wav')
        cloud = sec['derived'] if sec.get('derivedSource') == 'cloud' else derive(y, sr, sec['segments'])
        loc = sec['derived_local']
        if not cloud: continue
        cb = [r['start'] for r in cloud[1:]]; lb = [r['start'] for r in loc[1:]]
        rec = sum(1 for b in cb if any(abs(b - x) <= 3 for x in lb)) / max(1, len(cb)); prec = sum(1 for x in lb if any(abs(b - x) <= 3 for b in cb)) / max(1, len(lb))
        ts = np.arange(1.0, len(y) / sr - 1.0, 1.0); same = np.mean([tier_at(cloud, t) == tier_at(loc, t) for t in ts])
        hi = np.mean([(tier_at(cloud, t) == 'high') == (tier_at(loc, t) == 'high') for t in ts])
        r = {'fil': os.path.basename(f)[:40], 'molnGranser': len(cb), 'lokalGranser': len(lb), 'gransRecall': round(rec, 2), 'gransPrecision': round(prec, 2), 'tierLika': round(float(same), 2), 'highLika': round(float(hi), 2)}
        out.append(r); print('  ' + json.dumps(r, ensure_ascii=False)); print('     moln :', fmt(cloud)); print('     lokal:', fmt(loc))
    return out


if __name__ == '__main__':
    arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    if '--wav' in sys.argv:
        wavs = [a for a in sys.argv[1:] if a.lower().endswith('.wav')]; out = arg('--out', os.path.join(HERE, 'section-local'))
        os.makedirs(out, exist_ok=True)
        for w in wavs:
            t0 = time.time(); rows, local = run_file(w, None, float(arg('--min-seg', MIN_SEG_S)))
            if not rows: print(f'{os.path.basename(w)}: for kort/for fa slag'); continue
            name = os.path.splitext(os.path.basename(w))[0]
            m = apply_to_json({'row': {'title': name}, 'result': {'kind': 'section-local', 'analysis': {}}}, rows, local)
            json.dump(m, open(os.path.join(out, name + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print(f"{name:20} {local['secs']:6.1f} s (+valid {time.time() - t0 - local['secs']:.0f} s) slag {local['beatsSource']} {local['bpm']} BPM | {json.dumps(local['validation'])}")
            print('   ', fmt(rows))
    elif '--compare' in sys.argv:
        compare_cloud()
    else:
        n = backfill_corpus(force='--force' in sys.argv, min_s=float(arg('--min-s', 0)), only=(arg('--only') or '').lower())
        print(f'klart: {n} nya')
