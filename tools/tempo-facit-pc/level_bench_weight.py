"""NIVABANK, spektralviktningen (2026-09-23): forklarar gapet sim(full-band) tak-r 0,62 -> verkligt 0,33. Bygger wlevel som
alsaMic.emitBands (midHiRms*1.3 + bassRms*0.25, andelar = per-band-MEDELmagnitud mot 0,5) ur STFT och kor level_bench-
simuleringen pa den. Kor: level_bench_weight.py [N] [mag|pow|bandavg]; 'bandavg' = motorns matematik.
Resultat 09-23 (40 latar, bandavg): lowFrac median 0,89 (iqr 0,06) -> hiShare = hiFrac/0,5 ~0,22 -> input = amp x (0,25 + 2,6 hiFrac):
tak-r 0,62 -> 0,39, sim-tak~verkligt tak 0,41 -> 0,62, sim-bright~verkligt 0,60 -> 0,71. Viktningen ar en spektral-tilt-
modulator (+-4 dB av 10 dB-fonstret), inte en nivamatare - full-band-amp med samma kedja ger 0,62 (0,79 med sym EMA 150/fonster 18)."""
import json, os, sys, glob, time
import numpy as np, soundfile as sf, librosa
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import level_bench as L

MODE = sys.argv[2] if len(sys.argv) > 2 else 'bandavg'   # bandavg = emitBands (per-band-medel), mag = bin-summa |X|, pow = |X|^2

def weighted_env(fid):
    cf = os.path.join(L.CACHE, fid + f'.w{MODE}.npy')
    if os.path.exists(cf): return np.load(cf)
    y, sr = sf.read(os.path.join(L.CORPUS, fid + '.wav'), dtype='float32')
    if y.ndim > 1: y = y[:, 0]
    hop = int(sr * L.DT / 1000)
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop, center=False))
    if MODE == 'pow': S = S ** 2
    fr = librosa.fft_frequencies(sr=sr, n_fft=2048)
    if MODE == 'bandavg':   # emitBands: lowAbs = sub+kick+bass, hiAbs = lowMid..air, varje = MEDELmagnitud over bandets bins
        edges = [20, 60, 120, 250, 500, 1200, 3500, 10000, 16000]
        bands = [S[(fr >= edges[k]) & (fr < edges[k + 1])].mean(axis=0) for k in range(8)]
        low = bands[0] + bands[1] + bands[2]; hi = bands[3] + bands[4] + bands[5] + bands[6] + bands[7]
    else:
        low = S[(fr >= 20) & (fr < 250)].sum(axis=0); hi = S[(fr >= 250) & (fr < 16000)].sum(axis=0)
    tot = low + hi + 1e-12; lowFrac = low / tot; hiFrac = hi / tot
    env = L.load_env(fid); amp = env['full'].astype(float)
    n = min(len(amp), len(lowFrac)); lowFrac, hiFrac, amp = lowFrac[:n], hiFrac[:n], amp[:n]
    w = 1.3 * np.minimum(1, hiFrac / 0.5) + 0.25 * np.minimum(1, lowFrac / 0.5)
    out = np.stack([amp * w, lowFrac]); np.save(cf, out); return out

def main():
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    ids = []
    for f in sorted(glob.glob(os.path.join(L.CORPUS, '*.json'))):
        try: d = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        ev = d.get('events') or {}
        if len(ev.get('bright') or []) >= 1000 and os.path.exists(f[:-5] + '.wav') and (ev.get('pulses') or []): ids.append(os.path.basename(f)[:-5])
    step = max(1, len(ids) // N); ids = ids[::step][:N]
    rows = []; t0 = time.time()
    VAR = {'base': L.V(), 'hb0.99_shDown50': L.V(hbRel=0.99, shDown=50), 'sym_ema150_win18': L.V(att=150, rel=150, hbRel=0.99, shDown=25, win=18, off=7),
           'sym_ema150_win14': L.V(att=150, rel=150, hbRel=0.99, shDown=25, win=14, off=5.5)}
    for i, fid in enumerate(ids):
        d = json.load(open(os.path.join(L.CORPUS, fid + '.json'), encoding='utf-8')); ev = d['events']
        env = L.load_env(fid); t10, a_all = env['t10'], env['a_all']
        wl, lowFrac = weighted_env(fid)
        env2 = dict(env); env2['full'] = wl
        br = np.array(ev['bright'], dtype=float); bt, bv = br[:, 0], br[:, 1]
        beat = ev.get('beat') or {}; bpm = float(beat.get('bpm') or 120); trust = float(beat.get('trust') or 0.5); bd = 0.62 * max(0.35, trust)
        t100 = ev['captureStartWallMs'] + np.arange(len(wl)) * L.DT
        pn = L.pulse_env(t100, ev.get('pulses') or [], bpm)
        per_s = max(2, int(round(60000 / bpm / 100))); tak = L.rolling(bv, per_s, np.max)
        i2 = np.clip(np.searchsorted(t100, bt), 0, len(t100) - 1)
        R = {'id': fid, 'lowFrac_med': float(np.median(lowFrac)), 'lowFrac_iqr': float(np.percentile(lowFrac, 75) - np.percentile(lowFrac, 25)), 'sim': {}}
        for src, e in (('full', env), ('weighted', env2)):
            for name, P in VAR.items():
                ceil = L.sim_ceiling(e, P)[:len(t100)]; bs = L.with_pulses(ceil, pn, bd)
                lagc, rc, _ = L.facit_r(t10, a_all, t100, ceil); lagb, rb, _ = L.facit_r(t10, a_all, t100, bs)
                R['sim'][src + ':' + name] = {'ceil_r': rc, 'ceil_lag': lagc, 'br_r': rb, 'simtak_vs_realtak': float(np.corrcoef(ceil[i2], tak)[0, 1]), 'sim_vs_real': float(np.corrcoef(bs[i2], bv)[0, 1])}
        rows.append(R)
        if i % 10 == 0: print(f'  {i + 1}/{len(ids)} {time.time() - t0:.0f} s', flush=True)
    json.dump(rows, open(os.path.join(L.OUT, f'results_weight_{MODE}.json'), 'w'))
    print('n', len(rows), 'lowFrac median', L.med([r['lowFrac_med'] for r in rows]), 'iqr', L.med([r['lowFrac_iqr'] for r in rows]))
    print(f"  {'kalla:variant':32s} {'tak r':>6s} {'lag':>5s} {'br r':>6s} {'simtak~realtak':>14s} {'sim~real':>8s}")
    for k in rows[0]['sim']:
        print(f"  {k:32s} {L.med([r['sim'][k]['ceil_r'] for r in rows])!s:>6s} {L.med([r['sim'][k]['ceil_lag'] for r in rows])!s:>5s} {L.med([r['sim'][k]['br_r'] for r in rows])!s:>6s} {L.med([r['sim'][k]['simtak_vs_realtak'] for r in rows])!s:>14s} {L.med([r['sim'][k]['sim_vs_real'] for r in rows])!s:>8s}")

if __name__ == '__main__': main()
