r"""UPPGANGSLAG (2026-10-06): nivakanalens lag matt BARA pa uppgangar, i 10 ms-raster. pc.level.lagMs (level_analysis)
korskorrelerar hela kurvan i 100 ms-raster - den domineras av avklingningen (fade-down, last av agaren) och har 100 ms upplosning.
Metod: ljudets stigande flanker i RMS med 10 ms hopp (helband + bas < 200 Hz; >= 6 dB inom 60 ms). Handelselast medelkurva av
bright (10 Hz = lastSent.pct, linjart interpolerat) kring flankerna MINUS samma kurva kring slumpade tidpunkter (+-1-3 s) -
lampan ror sig hela tiden, och en traffmetod per flank gav lika manga 'traffar' pa slumpade tider (nollprov 10-06). Samma
medelkurva for ljudets normerade dB; lag = ljusets dal->topp-mittpunkt minus ljudets (t10/t50/t90), bootstrap over latar.
Resultat 10-06 (599 fangster 09-25..10-04, energilage): bas lag t50 77 ms (90 % 72-84), t10 51, t90 113; helband 83 (78-91).
Ljusets egen stigtid 10->90 % ~93 ms mot ljudets ~31 ms. Gamla matet pa samma latar: 200 ms.
Kor: .venv\Scripts\python.exe level_rise.py [--since 2026-09-25] [--max N] [--json ut.json] [--boot 200]   (~1 min)"""
import argparse, glob, json, os, sys
from datetime import datetime
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.environ.get('LOTUS_CORPUS_DIR') or os.path.join(HERE, 'corpus')
HOP_MS = 10.0
RISE_DB = 6.0        # flank: dB stiger minst sa mycket ...
RISE_WIN_MS = 60     # ... inom detta fonster
PRE_MS = 200         # nivan fore = median av dB i fonstret fore flanken
POST_MS = 150        # toppen efter = max i fonstret efter
REFRACT_MS = 400     # minsta avstand mellan flanker


def rms_db(x: np.ndarray, sr: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64); hop = int(sr * HOP_MS / 1000); fr = hop * 2   # float64: tiderna ar vaggklocka ~1,8e12 ms
    n = max(0, (len(x) - fr) // hop + 1)
    if n == 0: return np.array([])
    idx = np.arange(fr)[None, :] + hop * np.arange(n)[:, None]
    return 10 * np.log10(np.mean(x[idx] ** 2, axis=1) + 1e-12)   # ram-mitt = i*hop + hop -> tid (i+1)*HOP_MS


def edges(db: np.ndarray) -> list:
    """Stigande flanker: (index for mittkorsning, fore-niva, topp)."""
    w = int(RISE_WIN_MS / HOP_MS); pre = int(PRE_MS / HOP_MS); post = int(POST_MS / HOP_MS); refr = int(REFRACT_MS / HOP_MS)
    out, last = [], -10 ** 9
    for i in range(pre, len(db) - post - w):
        if i - last < refr: continue
        if db[i + w] - db[i] < RISE_DB: continue
        lo = float(np.median(db[i - pre:i])); hi = float(db[i:i + w + post].max())
        if hi - lo < RISE_DB: continue
        mid = (lo + hi) / 2
        j = i + int(np.argmax(db[i:i + w + post] >= mid))
        # sub-hopp: interpolera korsningen mellan j-1 och j
        a, b = db[j - 1], db[j]
        frac = (mid - a) / (b - a) if b > a else 0.0
        out.append((float(j - 1 + frac), lo, hi)); last = i
    return out


TAU = np.arange(-300, 801, 10.0)   # ms runt ljudets flank


def analyse(js: str, rng):
    """Handelselast medelkurva: bright (10 Hz, linjart interpolerat) kring varje ljudflank, minus baslinjen 0-200 ms fore.
    Samma for slumpade tidpunkter (null, +-1-3 s fran flankerna) - skillnaden = ljusets svar pa flanken, brus utmedlat."""
    d = json.load(open(js, encoding='utf-8')); d = d.get('events') or d   # fangstens handelser ligger under 'events'
    br = d.get('bright') or []
    wav = js[:-5] + '.wav'
    if len(br) < 50 or not os.path.exists(wav) or not d.get('captureStartWallMs'): return None
    x, sr = sf.read(wav, dtype='float32', always_2d=True); x = x.mean(axis=1)
    bt = np.array([b[0] for b in br], dtype=float); bv = np.array([b[1] for b in br], dtype=float)
    t_start = float(d['captureStartWallMs'])
    lp = butter(4, 200, 'lowpass', fs=sr, output='sos')
    res = {'id': os.path.basename(js)[:-5]}
    for name, sig in (('hel', x), ('bas', sosfilt(lp, x))):
        acc = {'real': np.zeros(len(TAU)), 'null': np.zeros(len(TAU)), 'ljud': np.zeros(len(TAU)), 'n': 0}
        db = rms_db(sig, sr); p5, p95 = np.percentile(db, 5), np.percentile(db, 95)
        dbn = (db - p5) / max(1e-6, p95 - p5); tdb = t_start + (np.arange(len(db)) + 1) * HOP_MS
        for (ix, lo, hi) in edges(db):
            ta = t_start + (ix + 1) * HOP_MS
            tn = ta + rng.uniform(1000, 3000) * rng.choice([-1, 1])
            ok = True; curves = []
            for t in (ta, tn):
                tt = t + TAU
                if tt[0] < bt[0] or tt[-1] > bt[-1]: ok = False; break
                j = np.searchsorted(bt, tt); gap = bt[np.clip(j, 1, len(bt) - 1)] - bt[np.clip(j - 1, 0, len(bt) - 2)]
                if gap.max() > 150: ok = False; break
                c = np.interp(tt, bt, bv); curves.append(c - c[(TAU >= -200) & (TAU <= 0)].mean())
            if not ok: continue
            acc['real'] += curves[0]; acc['null'] += curves[1]; acc['n'] += 1
            a = np.interp(ta + TAU, tdb, dbn); acc['ljud'] += a - a[(TAU >= -200) & (TAU <= 0)].mean()
        res[name] = acc
    return res


def crossings(ex: np.ndarray):
    """Uppgangen i en medelkurva: dal = min i -150..+100 ms, topp = max inom 400 ms efter dalen; tider da kurvan
    passerar 10/50/90 % av dal->topp. Samma definition for ljud och ljus -> lag = ljus - ljud."""
    m = (TAU >= -150) & (TAU <= 100); tr = int(np.argmax(np.where(m, -ex, -1e9)))
    m2 = (TAU > TAU[tr]) & (TAU <= TAU[tr] + 400); pk = int(np.argmax(np.where(m2, ex, -1e9)))
    lo, top = ex[tr], ex[pk]
    out = {'dalMs': float(TAU[tr]), 'toppMs': float(TAU[pk]), 'hojd': round(float(top - lo), 3)}
    for q in (0.1, 0.5, 0.9):
        lev = lo + q * (top - lo)
        k = next((i for i in range(tr + 1, pk + 1) if ex[i] >= lev), None)
        if k is None: out[f't{int(q*100)}'] = None; continue
        f = (lev - ex[k - 1]) / (ex[k] - ex[k - 1]) if ex[k] > ex[k - 1] else 0.0
        out[f't{int(q*100)}'] = round(float(TAU[k - 1] + f * 10), 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='2026-09-25', help='bara fangster efter detta datum (energilaget 09-24 21:45)')
    ap.add_argument('--max', type=int, default=0); ap.add_argument('--json', default=''); ap.add_argument('--boot', type=int, default=200)
    a = ap.parse_args()
    since = datetime.fromisoformat(a.since).timestamp() * 1000
    rng = np.random.default_rng(1)
    rows = []
    for js in sorted(glob.glob(os.path.join(CORPUS, '*.json'))):
        try:
            ev = json.load(open(js, encoding='utf-8')); ev = ev.get('events') or ev
            if (ev.get('captureStartWallMs') or 0) < since: continue
            r = analyse(js, rng)
        except Exception as e:
            print('fel', js, e, file=sys.stderr); continue
        if r and r['bas']['n']: rows.append(r)
        if a.max and len(rows) >= a.max: break
    out = {'filer': len(rows)}
    for k in ('hel', 'bas'):
        R = np.array([r[k]['real'] for r in rows]); N = np.array([r[k]['null'] for r in rows]); n = np.array([r[k]['n'] for r in rows])
        A = np.array([r[k]['ljud'] for r in rows])
        def lags(ix):
            nn = max(1, n[ix].sum()); lj = crossings((R[ix].sum(0) - N[ix].sum(0)) / nn); au = crossings(A[ix].sum(0) / nn)
            return lj, au
        lj, au = lags(np.arange(len(rows)))
        c = {'ljus': lj, 'ljud': au, 'flanker': int(n.sum())}
        for q in ('t10', 't50', 't90'):
            c['lag_' + q] = round(lj[q] - au[q], 1) if lj[q] is not None and au[q] is not None else None
        bs = []   # bootstrap over latar -> osakerhet i lag_t50
        for _ in range(a.boot):
            l2, a2 = lags(rng.integers(0, len(rows), len(rows)))
            if l2['t50'] is not None and a2['t50'] is not None: bs.append(l2['t50'] - a2['t50'])
        c['lag_t50_ci90'] = [round(float(np.percentile(bs, 5)), 1), round(float(np.percentile(bs, 95)), 1)] if bs else None
        c['kurvaLjus'] = {int(t): round(float(v), 3) for t, v in zip(TAU, (R.sum(0) - N.sum(0)) / max(1, n.sum())) if int(t) % 50 == 0}
        c['kurvaLjud'] = {int(t): round(float(v), 3) for t, v in zip(TAU, A.sum(0) / max(1, n.sum())) if int(t) % 50 == 0}
        out[k] = c
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if a.json: json.dump(out, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False)


if __name__ == '__main__':
    main()
