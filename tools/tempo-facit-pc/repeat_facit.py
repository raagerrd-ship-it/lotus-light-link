"""UPPREPNINGSFACIT (2026-09-22) - offline, icke-kausalt, hela klippet, utan moln. Svarar pa "vilka partier LATER som varandra?"
sa att 'refrang 2 = upprepning av refrang 1' kan domas akustiskt i stallet for med energitier-proxyn (bench.mjs REFRANG 2).

Metod:
  1. slag: Beat This!-slagen ur korpusens json (section_facit_local.beats_from_json; nedslag om de finns), annars librosa
     (tidsvarierande tempo, section_facit_local.beats_librosa). Takter = nedslag->nedslag; utan nedslag 4 slag med fasen som
     maximerar basonset + kromaandring (section_facit_local.bar_phase).
  2. sardrag @ 22,05 kHz (scipy resample_poly), hop 512: chroma_cqt (12), MFCC 1-19, log-RMS. Slagsynkade (median per slag), TAKTsynkade genom att
     de 4 (interpolerade) slagen i takten laggs efter varandra (ordningen inom takten bevaras -> en takt = en vektor
     48 + 76 + 4 dim). Standardiserade per dimension over laten.
  3. sjalvlikhet: cosinus per familj (kroma: max over transponering 0/+1/+2 halvtoner = tonartshojning i sista refrangen),
     viktad summa (kroma 0,5, MFCC 0,35, RMS 0,15) -> S[takt_i, takt_j].
  4. diagonalstrak: for lag L >= 8 takter: d_L[i] = S[i, i+L], utjamnat 3 takter, over troskel thr = median + k*MAD av alla
     S med |i-j| >= 8 (k = 2,0) och golv 0,30; sammanhangande korningar >= 4 takter = ett strak (i..i+n ~ i+L..i+L+n).
  5. segment: derived-granserna (moln eller lokalt, section_facit*.py) om de finns, FORFINADE med strakens andpunkter som
     ligger >= 4 takter fran alla andra granser (molnets 16-taktsblock rymmer ofta en 8-takters upprepad enhet; tier/score
     arvs fran det omslutande derived-segmentet; REPEAT_REFINE=0 stanger av), annars strakens andpunkter (bada sidor)
     snappade till taktstreck, sammanslagna < 4 takter. Segmentpar grupperas (union-find) om >= 60 % av det kortare
     segmentets takter ligger i ett strak vars partnertakter ligger i det andra segmentet (minst 3 takter) - straken bar
     alltsa alignmenten, sa det spelar ingen roll om derived delar refrangen olika de tva gangerna. Grupper A, B, C ...
     i forsta-forekomst-ordning, '-' = ingen upprepning.
  6. refrang: bland grupper med >= 2 forekomster (intilliggande segment i samma grupp = EN forekomst) valjs den med hogst
     energi (derived 'score' = dB + basonset-z nar det finns, annars medel-dB per slag) -> chorus1 = forsta forekomsten som
     inte ar tier intro (eller low med start < 10 s: instrumentalt intro pa refrangens ackord), chorus2 = nasta, verse2 = det emellan.
Skriver repeats/<id>.json = {segments:[{start,end,group,tier,label}], chorus1, verse2, chorus2, method, params, ...}.
Kor:  .venv\\Scripts\\python.exe repeat_facit.py [--corpus <katalog>] [--out repeats] [--only <delstrang>] [--force] [--min-s 40]
      .venv\\Scripts\\python.exe repeat_facit.py --validate [--out repeats]      (jamfor med tier-proxyn, som bench.mjs)
"""
import glob, json, os, sys, time
import math
import numpy as np, soundfile as sf, librosa, scipy.ndimage, scipy.signal
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from section_facit_local import beats_from_json, beats_librosa, bar_phase, read_wav

SR = 22050; HOP = 512
PARAMS = dict(minLagBars=8, minRunBars=4, minPairBars=3, kMad=float(os.environ.get('REPEAT_K_MAD', '2.0')),
              thrFloor=float(os.environ.get('REPEAT_THR_FLOOR', '0.30')), wChroma=0.5, wMfcc=0.35, wRms=0.15,
              chromaShifts=(0, 1, 2), smoothBars=3, mergeMinBars=4, minPairShare=float(os.environ.get('REPEAT_PAIR_SHARE', '0.6')),
              refine=os.environ.get('REPEAT_REFINE', '1') == '1')


# ───────────────────────────── slag & takter ─────────────────────────────

def bars_from_beats(beats, downbeats, bass_at, cch_at):
    """-> lista av (k0, k1): slagindex for varje takt [k0, k1). Nedslag om de finns, annars 4 slag med lokal taktfas."""
    n = len(beats)
    if downbeats is not None and len(downbeats) >= 2:
        idx = sorted(set(int(np.argmin(np.abs(beats - d))) for d in downbeats if beats[0] - 0.2 <= d <= beats[-1] + 0.2))
        idx = [i for i in idx if i < n]
        bars = [(a, b) for a, b in zip(idx, idx[1:]) if 2 <= b - a <= 8]
        if len(bars) >= 6: return bars
    ph = bar_phase(range(n), bass_at, cch_at)
    starts = list(range(ph, n - 3, 4))
    return [(a, a + 4) for a in starts]


def beat_features(y22, beat_frames):
    """Slagsynkade sardrag: chroma (12,K), mfcc (19,K), logrms (1,K), + per-slag basonset och kromaandring (for taktfasen)."""
    S = librosa.feature.melspectrogram(y=y22, sr=SR, hop_length=HOP, n_fft=2048, n_mels=64, fmax=8000)
    logS = librosa.power_to_db(S, ref=np.max)
    mfcc = librosa.feature.mfcc(S=logS, n_mfcc=20)[1:]
    chroma = librosa.feature.chroma_cqt(y=y22, sr=SR, hop_length=HOP)
    rms = librosa.feature.rms(y=y22, frame_length=2048, hop_length=HOP)[0]
    logrms = 20 * np.log10(rms + 1e-6)
    bass = librosa.onset.onset_strength(S=librosa.power_to_db(librosa.feature.melspectrogram(y=y22, sr=SR, hop_length=HOP, n_mels=12, fmax=220), ref=np.max))
    n = min(mfcc.shape[1], chroma.shape[1], len(logrms), len(bass))
    bf = np.clip(np.asarray(beat_frames, dtype=int), 0, n - 1)
    edges = np.concatenate([bf, [n]])                                        # kolumn k = [bf[k], bf[k+1]) = slag k
    sync = lambda X, agg: librosa.util.sync(X[..., :n], edges, aggregate=agg)[:, :len(bf)]
    Fc, Fm, Fr = sync(chroma, np.median), sync(mfcc, np.median), sync(logrms[None, :], np.median)
    Fb = sync(bass[None, :], np.max)[0]
    zc = (Fc - Fc.mean(axis=1, keepdims=True)) / (Fc.std(axis=1, keepdims=True) + 1e-6)
    cchange = np.r_[0, np.linalg.norm(np.diff(zc, axis=1), axis=0)]
    return Fc, Fm, Fr, Fb, cchange


def bar_matrix(F, bars, nb=4):
    """(D, K slag) -> (D*nb, takter): de nb interpolerade slagen i takten efter varandra."""
    out = np.zeros((F.shape[0] * nb, len(bars)))
    for t, (a, b) in enumerate(bars):
        cols = F[:, a:b]
        if cols.shape[1] == 0: continue
        src = np.linspace(0, cols.shape[1] - 1, nb)
        lo = np.floor(src).astype(int); hi = np.minimum(lo + 1, cols.shape[1] - 1); w = src - lo
        out[:, t] = (cols[:, lo] * (1 - w) + cols[:, hi] * w).T.reshape(-1)
    return out


def zscore_rows(X):
    return (X - X.mean(axis=1, keepdims=True)) / (X.std(axis=1, keepdims=True) + 1e-6)


def cosine_ssm(X):
    Xn = X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    return Xn.T @ Xn


def self_similarity(Fc, Fm, Fr, bars, p=PARAMS):
    """S (takter x takter) = viktad cosinus over kroma (transponeringstolerant), MFCC och RMS pa taktvektorer."""
    Bm = zscore_rows(bar_matrix(Fm, bars)); Br = zscore_rows(bar_matrix(Fr, bars))
    Sm, Sr = cosine_ssm(Bm), cosine_ssm(Br)
    Sc = None
    for sh in p['chromaShifts']:                                             # kroma i takt j transponerad sh upp mot takt i
        Bc0 = zscore_rows(bar_matrix(Fc, bars))
        Bcs = zscore_rows(bar_matrix(np.roll(Fc, sh, axis=0), bars))
        A = Bc0 / (np.linalg.norm(Bc0, axis=0, keepdims=True) + 1e-9); B = Bcs / (np.linalg.norm(Bcs, axis=0, keepdims=True) + 1e-9)
        s = A.T @ B; s = np.maximum(s, s.T)
        Sc = s if Sc is None else np.maximum(Sc, s)
    S = p['wChroma'] * Sc + p['wMfcc'] * Sm + p['wRms'] * Sr
    return S, {'chroma': Sc, 'mfcc': Sm, 'rms': Sr}


# ───────────────────────────── strak & grupper ─────────────────────────────

def threshold(S, p=PARAMS):
    N = S.shape[0]; iu = np.triu_indices(N, k=p['minLagBars'])
    if len(iu[0]) < 10: return p['thrFloor'], 0.0, 0.0
    v = S[iu]; med = float(np.median(v)); mad = float(np.median(np.abs(v - med))) * 1.4826
    return max(p['thrFloor'], med + p['kMad'] * mad), med, mad


def find_stripes(S, thr, p=PARAMS):
    """-> [(i0, i1, L)]: takterna i0..i1-1 upprepas vid i0+L..i1-1+L (L >= minLagBars, langd >= minRunBars)."""
    N = S.shape[0]; out = []
    for L in range(p['minLagBars'], N - p['minRunBars'] + 1):
        d = np.array([S[i, i + L] for i in range(N - L)])
        if p['smoothBars'] > 1: d = scipy.ndimage.uniform_filter1d(d, size=p['smoothBars'], mode='nearest')
        on = d >= thr; i = 0
        while i < len(on):
            if on[i]:
                j = i
                while j < len(on) and on[j]: j += 1
                if j - i >= p['minRunBars']: out.append((i, j, L, float(d[i:j].mean())))
                i = j
            else: i += 1
    return out


def bounds_from_stripes(stripes, nbars, p=PARAMS):
    """Utan derived: strakens andpunkter (bada sidor) som taktgranser; slas ihop < mergeMinBars takter."""
    pts = {0, nbars}
    for i0, i1, L, _ in stripes: pts.update([i0, i1, i0 + L, min(nbars, i1 + L)])
    pts = sorted(pts); merged = [pts[0]]
    for q in pts[1:]:
        if q - merged[-1] < p['mergeMinBars']:
            if q == pts[-1]: merged[-1] = q
            continue
        merged.append(q)
    if merged[-1] != nbars: merged.append(nbars)
    return merged


def refine_bounds(fixed, stripes, nbars, p=PARAMS):
    """Fasta granser (derived, takter) + strakens andpunkter som ligger >= mergeMinBars takter fran alla andra granser."""
    pts = set()
    for i0, i1, L, _ in stripes: pts.update([i0, i1, i0 + L, min(nbars, i1 + L)])
    out = sorted(set(fixed))
    for q in sorted(pts):
        if all(abs(q - f) >= p['mergeMinBars'] for f in out): out.append(q); out.sort()
    return out


def pair_coverage(matched, a0, a1, b0, b1, p=PARAMS):
    """Andel av det kortaste segmentets takter som ligger i ett strak vars partner-takt ligger i det andra segmentet
    (matched = {takt: {partner-takter}} ur straken, symmetrisk). -> (andel, antal takter)."""
    n = min(a1 - a0, b1 - b0)
    if n < p['minPairBars']: return 0.0, 0
    ma = sum(1 for i in range(a0, a1) if any(b0 <= j < b1 for j in matched.get(i, ())))
    mb = sum(1 for j in range(b0, b1) if any(a0 <= i < a1 for i in matched.get(j, ())))
    k = min(max(ma, mb), n)
    return k / n, k


def group_segments(S, stripes, seg_bars, p=PARAMS):
    """Union-find over segmentpar: samma grupp om >= minPairShare av det kortare segmentets takter ligger i diagonalstrak
    mot det andra segmentet (och minst minPairBars takter). -> (grupp per segment 'A'.. eller '-', parlista [i, j, andel, takter])."""
    matched = {}
    for i0, i1, L, _ in stripes:
        for i in range(i0, i1):
            matched.setdefault(i, set()).add(i + L); matched.setdefault(i + L, set()).add(i)
    n = len(seg_bars); parent = list(range(n)); pairs = []
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(n):
        for j in range(i + 1, n):
            share, k = pair_coverage(matched, *seg_bars[i], *seg_bars[j], p)
            if k: pairs.append([i, j, round(share, 2), k])
            if share >= p['minPairShare'] and k >= p['minPairBars']: parent[find(i)] = find(j)
    roots = [find(i) for i in range(n)]; counts = {r: roots.count(r) for r in set(roots)}
    names = {}; groups = []
    for i, r in enumerate(roots):
        if counts[r] < 2: groups.append('-'); continue
        if r not in names: names[r] = chr(ord('A') + len(names))
        groups.append(names[r])
    return groups, pairs


PICK_RULE = 'group=max energy; occurrence: skip tier intro, or tier low starting < 10 s'


def pick_chorus(segs, bar_s=2.0, group=None):
    """segs = [{start,end,group,tier,dbBeat,score?}] -> (chorus1, verse2, chorus2, chorusGroup, kandidater [(energi, grupp)]).
    Forekomst = intilliggande segment i samma grupp. Gruppen med hogst energi (derived 'score' nar alla segment har det,
    annars medel-dB per slag) bland dem med >= 2 forekomster ar refranggruppen. chorus1 = forsta forekomsten som INTE ar
    tier intro (eller low med start < 10 s): instrumentala intron pa refrangens ackord hamnar i refranggruppen (12/91 latar
    fick chorus1 = 0 s utan regeln, de med tier var intro/low). Att skippa ALLA low-forekomster kostade 16 chorus2 (83 -> 67),
    tier-proxyn ar for grov for det. chorus2 = nasta forekomst, verse2 = det emellan om >= 2 takter."""
    occ = []
    for i, s in enumerate(segs):
        if s['group'] == '-': continue
        if occ and occ[-1]['group'] == s['group'] and occ[-1]['segIdx'][-1] == i - 1:
            occ[-1]['end'] = s['end']; occ[-1]['segIdx'].append(i); continue
        occ.append({'group': s['group'], 'start': s['start'], 'end': s['end'], 'segIdx': [i]})
    by_group = {}
    for o in occ: by_group.setdefault(o['group'], []).append(o)
    use_score = all(x.get('score') is not None for x in segs)
    cand = []
    for g, os_ in by_group.items():
        if len(os_) < 2: continue
        en = [(segs[i]['score'] if use_score else segs[i]['dbBeat']) for o in os_ for i in o['segIdx']]
        en = [e for e in en if e is not None]
        cand.append((float(np.mean(en)) if en else -99.0, g))
    if not cand: return None, None, None, None, cand
    cand.sort(reverse=True); g = group if group in by_group and len(by_group[group]) >= 2 else cand[0][1]   # group = behall tidigare val (repick)
    ok = [o for o in by_group[g] if not all(segs[i].get('tier') == 'intro' or (segs[i].get('tier') == 'low' and o['start'] < 10) for i in o['segIdx'])]
    if len(ok) < 2: return None, None, None, g, cand
    c1 = {'start': round(ok[0]['start'], 2), 'end': round(ok[0]['end'], 2)}; c2 = {'start': round(ok[1]['start'], 2), 'end': round(ok[1]['end'], 2)}
    v2 = {'start': c1['end'], 'end': c2['start']} if c2['start'] - c1['end'] >= 2 * bar_s else None
    return c1, v2, c2, g, cand


def repick(out_dir):
    """Rakna om chorus1/verse2/chorus2 i befintliga sidofiler ur deras segments (utan ny analys)."""
    n = 0
    for f in sorted(glob.glob(os.path.join(out_dir, '*.json'))):
        r = json.load(open(f, encoding='utf-8'))
        c1, v2, c2, g, cand = pick_chorus(r['segments'], r.get('barS') or 2.0, group=r.get('chorusGroup'))
        r.update({'chorus1': c1, 'verse2': v2, 'chorus2': c2, 'chorusGroup': g, 'pickRule': PICK_RULE, 'groupEnergy': {gg: round(v, 2) for v, gg in cand}})
        json.dump(r, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=1); n += 1
    print(f'repick: {n} filer')


# ───────────────────────────── huvudflode ─────────────────────────────

def analyse(wav, m=None, p=PARAMS, derived=None):
    t0 = time.time()
    y, sr = read_wav(wav)
    y22 = resample(y, sr)
    dur = len(y22) / SR
    bj = beats_from_json(m) if m else None
    if bj: beats, downs, bsrc = bj
    else:
        oenv = librosa.onset.onset_strength(y=y22, sr=SR, hop_length=HOP)
        beats, downs, bsrc = list(beats_librosa(y22, oenv)), None, 'librosa'
    beats = np.asarray(sorted(b for b in beats if 0 <= b < dur), dtype=float)
    if len(beats) < 16: return None
    bframes = librosa.time_to_frames(beats, sr=SR, hop_length=HOP)
    Fc, Fm, Fr, Fb, cch = beat_features(y22, bframes)
    bars = bars_from_beats(beats, downs, Fb, cch)
    if len(bars) < p['minLagBars'] + p['minRunBars']: return None
    bar_t = [float(beats[a]) for a, _ in bars] + [float(beats[bars[-1][1]]) if bars[-1][1] < len(beats) else dur]
    S, fam = self_similarity(Fc, Fm, Fr, bars, p)
    thr, med, mad = threshold(S, p)
    stripes = find_stripes(S, thr, p)
    nb = len(bars)
    # segment -> takter
    to_bar = lambda t: int(np.clip(np.argmin(np.abs(np.asarray(bar_t) - t)), 0, nb))
    if derived and len(derived) >= 2:
        # derived-granserna (takter) + strakens andpunkter som forfining (>= mergeMinBars fran alla andra granser) - molnets
        # segment ar ofta 16-taktsblock dar den upprepade enheten ar 8 takter inuti (Do Both: 11,7-29,5 ~ 42,9-60,6 s).
        dbars = sorted(set([0, nb] + [to_bar(x['start']) for x in derived[1:]]))
        bb = refine_bounds(dbars, stripes, nb, p) if p['refine'] else dbars
        seg_src = 'derived+stripes' if len(bb) > len(dbars) else 'derived'
        def encl(t):
            for x in derived:
                if float(x['start']) <= t < float(x['end']): return x
            return derived[-1] if t >= float(derived[-1]['end']) else derived[0]
        segs = []
        for a, b in zip(bb, bb[1:]):
            x = encl((bar_t[a] + bar_t[b]) / 2)
            segs.append({'start': bar_t[a] if a > 0 else float(derived[0]['start']), 'end': bar_t[b] if b < nb else float(derived[-1]['end']),
                         'tier': x.get('tier'), 'label': x.get('label'), 'db': x.get('db'), 'score': x.get('score'), 'bars': (a, b)})
    else:
        seg_src = 'stripes'
        bb = bounds_from_stripes(stripes, nb, p)
        segs = [{'start': bar_t[a], 'end': bar_t[b], 'tier': None, 'label': 'seg', 'db': None, 'bars': (a, b)} for a, b in zip(bb, bb[1:])]
    seg_bars = [s['bars'] for s in segs]
    # energi per segment (medel-dB ur RMS pa slagkolumnerna)
    beat_t = beats
    for s in segs:
        mask = (beat_t >= s['start']) & (beat_t < s['end'])
        s['dbBeat'] = round(float(np.mean(Fr[0, mask])), 2) if mask.any() else None
    groups, pairs = group_segments(S, stripes, seg_bars, p)
    for s, g in zip(segs, groups): s['group'] = g; s['bars'] = list(s['bars'])
    chorus1, verse2, chorus2, chorus_group, cand = pick_chorus(segs, bar_s=float(np.median(np.diff(bar_t))) if len(bar_t) > 2 else 2.0)
    out = {'segments': [{'start': round(s['start'], 2), 'end': round(s['end'], 2), 'group': s['group'], 'tier': s['tier'], 'label': s['label'], 'dbBeat': s['dbBeat'], 'score': s.get('score'), 'bars': s['bars']} for s in segs],
           'chorus1': chorus1, 'verse2': verse2, 'chorus2': chorus2, 'chorusGroup': chorus_group, 'pickRule': PICK_RULE,
           'method': 'ssm-bar-chroma-mfcc-rms-stripes-unionfind', 'params': {k: (list(v) if isinstance(v, tuple) else v) for k, v in p.items()},
           'segSource': seg_src, 'beatsSource': bsrc, 'nBars': nb, 'barS': round(float(np.median(np.diff(bar_t))), 3) if len(bar_t) > 2 else None,
           'thr': round(thr, 3), 'ssmMedian': round(med, 3), 'ssmMad': round(mad, 3),
           'stripes': [{'bars': [i0, i1], 'lagBars': L, 'startS': round(bar_t[i0], 2), 'endS': round(bar_t[min(i1, nb)], 2), 'repeatAtS': round(bar_t[min(i0 + L, nb)], 2), 'score': round(sc, 3)} for i0, i1, L, sc in stripes],
           'pairs': pairs, 'groupEnergy': {g: round(v, 2) for v, g in cand}, 'energyKey': 'score' if (derived and all(x.get('score') is not None for x in derived)) else 'dbBeat', 'durS': round(dur, 2),
           'secs': round(time.time() - t0, 1), 'at': int(time.time())}
    return out


def resample(y, sr):
    """scipy resample_poly (0,7 s for 150 s @48k; librosas polyphase/soxr tar 6 s)."""
    if sr == SR: return y
    g = math.gcd(int(sr), SR); return scipy.signal.resample_poly(y, SR // g, int(sr) // g).astype(np.float32)


def derived_of(m):
    sec = (((m.get('result') or {}).get('analysis') or {}).get('sections') or {})
    return sec.get('derived') if isinstance(sec, dict) else None


def proxy_of(derived):
    """bench.mjs REFRANG 2-proxyn: forsta high = refrang 1, andra high (med icke-high emellan) = refrang 2."""
    if not derived: return None
    hi = [i for i, g in enumerate(derived) if g.get('tier') == 'high']
    if len(hi) < 2 or not any(g.get('tier') != 'high' for g in derived[hi[0] + 1:hi[1]]): return None
    return {'chorus1': derived[hi[0]], 'chorus2': derived[hi[1]]}


def run_corpus(corpus, out_dir, only='', force=False, min_s=40.0, verbose=True):
    os.makedirs(out_dir, exist_ok=True); n = 0; secs = []
    for f in sorted(glob.glob(os.path.join(corpus, '*.json'))):
        wav = f[:-5] + '.wav'; idn = os.path.basename(f)[:-5]
        if not os.path.exists(wav) or (only and only not in idn.lower()): continue
        dst = os.path.join(out_dir, idn + '.json')
        if os.path.exists(dst) and not force: continue
        try: m = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        if (m.get('result') or {}).get('method') == 'brus': continue
        try:
            info = sf.info(wav)
            if 0 < info.frames / info.samplerate < min_s: continue
            res = analyse(wav, m, derived=derived_of(m))
        except Exception as e:
            if verbose: print(f'  FEL {idn[:40]}: {str(e)[:160]}', flush=True)
            continue
        if not res: continue
        res['id'] = idn; res['title'] = f"{(m.get('row') or {}).get('artist', '')} - {(m.get('row') or {}).get('title', '')}"
        json.dump(res, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1); n += 1; secs.append(res['secs'])
        if verbose:
            c1, c2 = res['chorus1'], res['chorus2']
            print(f"  {idn[:40]:40} {res['secs']:5.1f}s takter {res['nBars']:3d} thr {res['thr']:.2f} strak {len(res['stripes']):3d} seg {res['segSource'][:3]} "
                  f"{' '.join(s['group'] for s in res['segments'])}  ref1 {c1['start'] if c1 else '-'}-{c1['end'] if c1 else ''} ref2 {c2['start'] if c2 else '-'}", flush=True)
    if secs: print(f'klart: {n} filer, {np.median(secs):.1f} s/lat (median), {sum(secs):.0f} s totalt')
    return n


def validate(corpus, out_dir, tol=4.0):
    """Hur ofta sammanfaller tier-proxyns refrang 2 med det akustiska (start inom +-tol s)? Hur manga far chorus2 alls?"""
    rows = []
    for f in sorted(glob.glob(os.path.join(out_dir, '*.json'))):
        r = json.load(open(f, encoding='utf-8')); idn = os.path.basename(f)[:-5]
        cj = os.path.join(corpus, idn + '.json'); m = json.load(open(cj, encoding='utf-8')) if os.path.exists(cj) else {}
        pr = proxy_of(derived_of(m))
        rows.append({'id': idn, 'dur': r['durS'], 'c1': r['chorus1'], 'v2': r['verse2'], 'c2': r['chorus2'], 'proxy': pr, 'seg': r['segSource'], 'nStripes': len(r['stripes']),
                     'groups': ''.join(s['group'] for s in r['segments']), 'thr': r['thr'], 'beats': r['beatsSource']})
    n = len(rows); long_ = [r for r in rows if r['dur'] >= 100]
    has = lambda k, rs: sum(1 for r in rs if r[k])
    print(f'filer {n} (langa >= 100 s: {len(long_)}): chorus1 {has("c1", rows)}, verse2 {has("v2", rows)}, chorus2 {has("c2", rows)} | langa: chorus1 {has("c1", long_)}, verse2 {has("v2", long_)}, chorus2 {has("c2", long_)}')
    both = [r for r in rows if r['c2'] and r['proxy']]
    hit2 = [r for r in both if abs(r['c2']['start'] - r['proxy']['chorus2']['start']) <= tol]
    hit1 = [r for r in both if abs(r['c1']['start'] - r['proxy']['chorus1']['start']) <= tol]
    only_p = [r for r in rows if r['proxy'] and not r['c2']]; only_r = [r for r in rows if r['c2'] and not r['proxy']]
    print(f'proxy finns {sum(1 for r in rows if r["proxy"])}, bada {len(both)}: refrang 2-start inom +-{tol:.0f} s {len(hit2)}/{len(both)}, refrang 1-start {len(hit1)}/{len(both)}; bara proxy {len(only_p)}, bara akustiskt {len(only_r)}')
    for r in both:
        d2 = r['c2']['start'] - r['proxy']['chorus2']['start']; d1 = r['c1']['start'] - r['proxy']['chorus1']['start']
        print(f"  {r['id'][:36]:36} {r['groups']:14} akust ref1 {r['c1']['start']:6.1f} ref2 {r['c2']['start']:6.1f} | proxy ref1 {r['proxy']['chorus1']['start']:6.1f} ref2 {r['proxy']['chorus2']['start']:6.1f} | d1 {d1:+6.1f} d2 {d2:+6.1f} {'OK' if abs(d2) <= tol else ''}")
    by_seg = {}
    for r in rows: by_seg.setdefault(r['seg'], []).append(r)
    for k, rs in by_seg.items(): print(f'  segkalla {k}: {len(rs)} filer, chorus2 {has("c2", rs)}, strak median {int(np.median([r["nStripes"] for r in rs]))}')
    return rows


if __name__ == '__main__':
    arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    corpus = arg('--corpus', os.path.join(HERE, 'corpus')); out = arg('--out', os.path.join(HERE, 'repeats'))
    if '--validate' in sys.argv: validate(corpus, out, float(arg('--tol', 4.0)))
    elif '--repick' in sys.argv: repick(out)
    else: run_corpus(corpus, out, only=(arg('--only') or '').lower(), force='--force' in sys.argv, min_s=float(arg('--min-s', 40)))
