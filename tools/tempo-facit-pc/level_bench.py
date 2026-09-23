"""NIVABANK (2026-09-23): nivakanalen offline mot korpusens langfangster. (B) tak for r med perfekt kunskap (idealkurvor med
motorns taktpuls), (C) motorns bright dekomponerad tak/puls + lagkurvor, (E) motorns nivakedja simulerad ur WAV:en
(lightRawRms-EMA -> release 350 -> dB-fonster med auto-ankare -> shapeSm -> heartbeat) med varianter, r/lag per variant
mot samma facit-mal som level_analysis. Kor: .venv\\Scripts\\python.exe level_bench.py [N] (N spridda latar, ~20 s/lat)
eller `level_bench.py report` pa sparad results.json. Laser bara korpusen; cache/resultat i %TEMP%\\lotus-level-bench.
Resultat 09-23 (40 latar): mal+puls 0,85, fonster10+puls 0,77 (= taket for `r` med pulsen kvar); motorns kedja pa
full-band-RMS: tak 0,62 lag 300, med puls 0,45; verkligt bright 0,33/700 (platt lagkurva). Gapet forklaras av emitBands'
spektralviktning (level_bench_weight.py: per-band-MEDEL ger lowFrac 0,89 -> hiShare 0,22 -> input = amp x (0,25 + 2,6 hiFrac),
tak-r 0,39, sim~verkligt 0,71). Basta varianter: sym EMA 150 + fonster 18/7: tak 0,79 lag 200; utan heartbeat-release +
shapeSm 50: 0,72/200. Sektionsdynamiken (LOTUS_SECTION_DYN_DB) neutral (+-0,05). Band-RMS hp150/mid: samre (0,41)."""
import json, glob, os, sys, time
import numpy as np, soundfile as sf, librosa
from scipy.signal import butter, sosfilt

import tempfile
CORPUS = os.environ.get('LOTUS_CORPUS_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpus')
OUT = os.path.join(tempfile.gettempdir(), 'lotus-level-bench'); CACHE = os.path.join(OUT, 'envcache')
os.makedirs(CACHE, exist_ok=True)
FLOOR = 0.18
DT = 10.0   # sim-raster ms

# ───────────── facit (exakt kopia av level_analysis' malkurva + lagsokning) ─────────────
def facit_target(y, sr, start_ms):
    hop = int(sr * 0.1)
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop, center=True)[0]
    t_ms = start_ms + np.arange(len(rms)) * 100.0
    db = 20 * np.log10(rms + 1e-6)
    p5, p95 = np.percentile(db, 5), np.percentile(db, 95)
    return t_ms, (db - p5) / max(1e-6, p95 - p5), db, p95 - p5

def facit_r(t_ms, a_all, bt, bv, lags=range(-5, 16), curve=None):
    idx = np.clip(np.searchsorted(bt, t_ms), 0, len(bt) - 1)
    b_all = bv[idx]; valid = np.abs(bt[idx] - t_ms) < 150
    best = None
    for lag in lags:
        if lag >= 0: a, c, v = a_all[:len(a_all) - lag], b_all[lag:], valid[lag:]
        else: a, c, v = a_all[-lag:], b_all[:len(b_all) + lag], valid[:len(b_all) + lag]
        a, c = a[v], c[v]
        if len(a) < 30 or a.std() < 1e-6 or c.std() < 1e-6: continue
        r = float(np.corrcoef(a, c)[0, 1])
        if curve is not None: curve[lag * 100] = round(r, 3)
        if best is None or r > best[1]: best = (lag * 100, r)
    r0 = float(np.corrcoef(a_all[valid], b_all[valid])[0, 1]) if valid.sum() > 30 and b_all[valid].std() > 1e-6 else 0.0
    return (best[0] if best else None), (best[1] if best else None), r0

# ───────────── envelopes (100 Hz) ─────────────
def block_rms(y, sr, band):
    if band == 'full': x = y
    else:
        if band == 'hp150': sos = butter(4, 150, 'highpass', fs=sr, output='sos')
        elif band == 'bass': sos = butter(4, 150, 'lowpass', fs=sr, output='sos')
        elif band == 'mid': sos = butter(4, [150, 4000], 'bandpass', fs=sr, output='sos')
        x = sosfilt(sos, y)
    blk = int(sr * DT / 1000); n = len(x) // blk
    return np.sqrt((x[:n * blk].reshape(n, blk) ** 2).mean(axis=1))

def load_env(fid):
    cf = os.path.join(CACHE, fid + '.npz')
    if os.path.exists(cf):
        z = np.load(cf); return {k: z[k] for k in z.files}
    y, sr = sf.read(os.path.join(CORPUS, fid + '.wav'), dtype='float32')
    if y.ndim > 1: y = y.mean(axis=1)
    d = json.load(open(os.path.join(CORPUS, fid + '.json'), encoding='utf-8')); ev = d['events']
    t_ms, a_all, db, dyn = facit_target(y, sr, ev['captureStartWallMs'])
    out = {'t10': t_ms, 'a_all': a_all, 'db10': db, 'dyn': np.array([dyn])}
    for b in ('full', 'hp150', 'bass', 'mid'): out[b] = block_rms(y, sr, b)
    np.savez(cf, **out); return out

# ───────────── motorsim ─────────────
def ema_asym(x, dt, up_ms, down_ms):
    out = np.empty_like(x); s = x[0]
    a_up = 1.0 if up_ms <= 0 else 1 - np.exp(-dt / up_ms)
    a_dn = 1 - np.exp(-dt / max(1, down_ms))
    for i, v in enumerate(x):
        s += (v - s) * (a_up if v > s else a_dn); out[i] = s
    return out

def pulse_env(t100, pulses, bpm, rise=40.0, holdk=2.0, tau_k=0.35, tau_min=0.12, tau_max=1.2):
    """pn(t) in 0..1: max over active pulses of ppEnv(dt, 0.45)/0.45. Pulstider = fyrtid (vaggklocka ms)."""
    per = 60000.0 / max(1e-6, bpm)
    tau = float(np.clip(tau_k * per / 1000, tau_min, tau_max)) * 1000
    H = rise * holdk; peak = 1 - np.exp(-H / rise)
    pn = np.zeros(len(t100)); ps = np.sort(np.asarray(pulses, dtype=float))
    if not len(ps): return pn
    j = 0
    for i, t in enumerate(t100):
        while j < len(ps) and ps[j] <= t: j += 1
        best = 0.0
        for k in range(j - 1, max(-1, j - 5), -1):
            dt = t - ps[k]
            v = (1 - np.exp(-dt / rise)) if dt <= H else peak * np.exp(-(dt - H) / tau)
            if v > best: best = v
        pn[i] = best
    return pn

BASE = dict(win=10.0, off=4.5, rel=350.0, att=0.0, shUp=25.0, shDown=150.0, hbRel=0.396, hbAtt=1.0, softFloor=0.3,
            tauA=60.0, band='full', anchor='ema', seed='median', raw_ema=130.0, pre_ema=0.0)

def sim_ceiling(env, P):
    x = env[P['band']].astype(float)
    dt = DT
    # lightRawRms ~130 ms EMA av block-RMS
    if P['raw_ema'] > 0: x = ema_asym(x, dt, P['raw_ema'], P['raw_ema'])
    wl = ema_asym(x, dt, P['att'], P['rel'])
    wdb = 20 * np.log10(np.maximum(wl, 1e-9))
    win, off = P['win'], P['off']
    n = len(wdb)
    if P['anchor'] == 'oracle':
        anchor = np.full(n, np.percentile(wdb, 50) + off)
    elif P['anchor'] == 'pct':
        # glidande fonster 20 s: p90 = tak, p90-win = golv (kausalt)
        W = int(20000 / dt); anchor = np.empty(n)
        for i in range(n):
            seg = wdb[max(0, i - W):i + 1]; anchor[i] = np.percentile(seg, 90)
    else:
        tauMs = P['tauA'] * 1000
        seed = np.percentile(wdb, 50) if P['seed'] == 'median' else np.percentile(wdb[:int(20000 / dt)], 50)
        slow = seed; anchor = np.empty(n); last_shape = 0.5; clipRun = 0.0; fastUntil = -1.0
        for i in range(n):
            up = wdb[i] > slow
            farAbove = wdb[i] - slow > win; farBelow = slow - wdb[i] > win
            if last_shape >= 0.98 or last_shape <= 0.02:
                clipRun += dt
                if clipRun > 10000: fastUntil = i * dt + 5000
            else: clipRun = 0
            fast = farAbove or farBelow or (i * dt < fastUntil)
            a = 1 - np.exp(-dt / (tauMs / 10 if fast else tauMs * 3 if up else tauMs))
            slow += a * (wdb[i] - slow)
            anchor[i] = slow + off
            sh = (wdb[i] - (anchor[i] - win)) / win; last_shape = min(1, max(0, sh))
    shape = np.clip((wdb - (anchor - win)) / win, 0, 1)
    shape = ema_asym(shape, dt, P['shUp'], P['shDown'])
    # heartbeat
    sm = shape[0]; out = np.empty(n); eR = dt / 125.0
    aRel = 1 - (1 - P['hbRel']) ** eR; aAtt = 1 - (1 - P['hbAtt']) ** eR
    for i, s in enumerate(shape):
        if s < sm:
            c = max(sm, 1e-4); t = max(s, 1e-4); sm = c * (t / c) ** aRel
        else:
            k = P['softFloor'] + (1 - P['softFloor']) * min(1, s / 0.5); sm += aAtt * k * (s - sm)
        out[i] = min(1, max(0, sm))
    return out

def with_pulses(ceil, pn, bd):
    return FLOOR + ceil * (1 - FLOOR) * ((1 - bd) + bd * pn)

def rolling(x, w, fn):
    w = max(1, int(w)); pad = w // 2
    xp = np.pad(x, (pad, w - 1 - pad), mode='edge')
    return np.array([fn(xp[i:i + w]) for i in range(len(x))])

def analyse(fid, variants):
    d = json.load(open(os.path.join(CORPUS, fid + '.json'), encoding='utf-8')); ev = d['events']
    lv = ((d.get('result') or {}).get('analysis') or {}).get('level') or {}
    env = load_env(fid)
    t10, a_all, db10 = env['t10'], env['a_all'], env['db10']
    br = np.array(ev['bright'], dtype=float); bt, bv = br[:, 0], br[:, 1]
    beat = ev.get('beat') or {}; bpm = float(beat.get('bpm') or 120); trust = float(beat.get('trust') or 0.5)
    bd = 0.62 * max(0.35, trust)
    t100 = ev['captureStartWallMs'] + np.arange(len(env['full'])) * DT
    pn = pulse_env(t100, ev.get('pulses') or [], bpm)
    R = {'id': fid, 'artist': ev.get('artist'), 'title': ev.get('title'), 'bpm': round(bpm, 1), 'trust': round(trust, 2), 'dyn': round(float(env['dyn'][0]), 1),
         'stored_r': lv.get('r'), 'stored_lag': lv.get('lagMs')}
    # A. replikering
    cv = {}; lag, r, r0 = facit_r(t10, a_all, bt, bv, lags=range(-5, 26), curve=cv); R['rep_r'] = r; R['rep_lag'] = lag; R['rep_r0'] = r0; R['curve_real'] = cv
    # C. dekomposition av motorns bright
    per_s = max(2, int(round(60000 / bpm / 100)))
    tak = rolling(bv, per_s, np.max); golv = rolling(bv, per_s, np.min); puls = bv - tak
    R['var_bright'] = float(bv.var()); R['var_tak'] = float(tak.var()); R['var_puls'] = float(puls.var())
    R['tak_share'] = float(tak.var() / max(1e-9, bv.var()))
    R['moddepth'] = float(np.median(1 - golv / np.maximum(tak, 1e-6)))
    lag, r, _ = facit_r(t10, a_all, bt, tak); R['tak_r'] = r; R['tak_lag'] = lag
    p90 = rolling(bv, 2 * per_s, lambda z: np.percentile(z, 90)); lag, r, _ = facit_r(t10, a_all, bt, p90); R['p90_r'] = r; R['p90_lag'] = lag
    lp = ema_asym(bv, 100.0, 400.0, 400.0); lag, r, _ = facit_r(t10, a_all, bt, lp); R['lp_r'] = r; R['lp_lag'] = lag
    R['clip_share'] = float((tak >= 0.98).mean()); R['floor_share'] = float((tak <= 0.25).mean())
    R['bright_med'] = float(np.median(bv)); R['bright_p5'] = float(np.percentile(bv, 5)); R['bright_p95'] = float(np.percentile(bv, 95))
    # dynamikatergivning: regression tak (0..1) mot dB vid basta lag
    idx = np.clip(np.searchsorted(bt, t10), 0, len(bt) - 1); v = np.abs(bt[idx] - t10) < 150
    L = int((R['tak_lag'] or 0) / 100)
    if L >= 0: a, c = db10[:len(db10) - L][v[L:]], tak[idx][L:][v[L:]]
    else: a, c = db10[-L:][v[:len(v) + L]], tak[idx][:len(idx) + L][v[:len(v) + L]]
    if len(a) > 30 and a.std() > 0: R['pct_per_db'] = float(np.polyfit(a, c, 1)[0] * 100)
    # B. idealkurvor (perfekt kunskap om ljudet)
    ideal = {}
    a10 = np.clip(a_all, 0, 1)
    def r_of(series10):   # serie pa facit-rastret
        return facit_r(t10, a_all, t10, series10)
    pn10 = np.interp(t10, t100, pn)
    ideal['I1_target+puls'] = r_of(with_pulses(a10, pn10, bd))
    # perfekt statiskt ankare, fonster 10 dB runt p50+4.5 (= motorns fonster pa facit-signalen)
    p50 = np.percentile(db10, 50); shw = np.clip((db10 - (p50 + 4.5 - 10)) / 10, 0, 1)
    ideal['I2_window10_static'] = r_of(shw)
    ideal['I3_window10_static+puls'] = r_of(with_pulses(shw, pn10, bd))
    shw18 = np.clip((db10 - (p50 + 4.5 - 18)) / 18, 0, 1); ideal['I2b_window18_static'] = r_of(shw18)
    ideal['I2c_window18_static+puls'] = r_of(with_pulses(shw18, pn10, bd))
    # motorns egen glattning pa facit-malet (visar lagen som glattningen ensam ger)
    R['ideal'] = {k: {'lag': v[0], 'r': v[1]} for k, v in ideal.items()}
    # E. motorsim + varianter
    sims = {}
    for name, P in variants.items():
        ceil = sim_ceiling(env, P)
        bs = with_pulses(ceil, pn, bd)
        cvc = {} if name == 'base' else None; cvb = {} if name == 'base' else None
        lagc, rc, _ = facit_r(t10, a_all, t100, ceil, curve=cvc); lagb, rb, _ = facit_r(t10, a_all, t100, bs, curve=cvb)
        if name == 'base': R['curve_sim_ceil'] = cvc; R['curve_sim_br'] = cvb
        e = {'ceil_r': rc, 'ceil_lag': lagc, 'br_r': rb, 'br_lag': lagb, 'clip': float((ceil >= 0.98).mean()), 'floor': float((ceil <= 0.05).mean())}
        if name == 'base':
            # validering: sim mot verkligt bright (samma tider)
            i2 = np.clip(np.searchsorted(t100, bt), 0, len(t100) - 1)
            e['sim_vs_real_r'] = float(np.corrcoef(bs[i2], bv)[0, 1]); e['simtak_vs_realtak_r'] = float(np.corrcoef(ceil[i2], tak)[0, 1])
            e['sim_vs_real_lag'] = facit_r(bt, bv, t100, bs, lags=range(-10, 11))[0]
        sims[name] = e
    R['sim'] = sims
    return R

def V(**kw):
    p = dict(BASE); p.update(kw); return p

VARIANTS = {
    'base': V(),
    'seed_first20': V(seed='first20'),
    'anchor_oracle': V(anchor='oracle'),
    'anchor_pct90_20s': V(anchor='pct'),
    'win14': V(win=14), 'win18': V(win=18), 'win18_off7': V(win=18, off=7), 'win24_off8': V(win=24, off=8),
    'rel150': V(rel=150), 'rel600': V(rel=600), 'rel60': V(rel=60), 'att60': V(att=60), 'att60_rel150': V(att=60, rel=150),
    'tauA20': V(tauA=20), 'tauA300': V(tauA=300),
    'hbRel0.7': V(hbRel=0.7), 'hbRel0.15': V(hbRel=0.15), 'hbRel0.99': V(hbRel=0.99),
    'shDown400': V(shDown=400), 'shDown50': V(shDown=50), 'shDown50_hb0.99': V(shDown=50, hbRel=0.99),
    'band_hp150': V(band='hp150'), 'band_mid': V(band='mid'), 'band_bass': V(band='bass'),
    'sym_ema300': V(att=300, rel=300, hbRel=0.99, shDown=25),      # symmetrisk glattning, ingen releasekedja
    'sym_ema300_win18': V(att=300, rel=300, hbRel=0.99, shDown=25, win=18, off=7),
    'sym_ema150_win18': V(att=150, rel=150, hbRel=0.99, shDown=25, win=18, off=7),
    'sym_ema300_win18_oracle': V(att=300, rel=300, hbRel=0.99, shDown=25, win=18, off=7, anchor='oracle'),
    'sym_ema300_win14': V(att=300, rel=300, hbRel=0.99, shDown=25, win=14, off=5.5),
}

def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float)) and x is not None and np.isfinite(x)]
    return round(float(np.median(xs)), 3) if xs else None

def main():
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    ids = []
    for f in sorted(glob.glob(os.path.join(CORPUS, '*.json'))):
        try: d = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        ev = d.get('events') or {}
        if len(ev.get('bright') or []) >= 1000 and os.path.exists(f[:-5] + '.wav') and (ev.get('pulses') or []): ids.append(os.path.basename(f)[:-5])
    step = max(1, len(ids) // N); ids = ids[::step][:N]
    print('n latar', len(ids)); t0 = time.time()
    res = []
    for i, fid in enumerate(ids):
        try: res.append(analyse(fid, VARIANTS))
        except Exception as e: print('FEL', fid, e)
        if i % 10 == 0: print(f'  {i + 1}/{len(ids)} {time.time() - t0:.0f} s', flush=True)
    json.dump(res, open(os.path.join(OUT, 'results.json'), 'w'), indent=0)
    report(res)

def report(res):
    n = len(res)
    print('\n== A. replikering av facit-r ==')
    print('stored r med', med([r['stored_r'] for r in res]), 'replikerad r med', med([r['rep_r'] for r in res]), 'max|diff|',
          round(max(abs((r['stored_r'] or 0) - (r['rep_r'] or 0)) for r in res), 3), 'lag med', med([r['rep_lag'] for r in res]))
    print('\n== B. tak for r med perfekt kunskap (median over', n, 'latar) ==')
    for k in res[0]['ideal']:
        print(f"  {k:32s} r {med([r['ideal'][k]['r'] for r in res])}  lag {med([r['ideal'][k]['lag'] for r in res])}")
    print('\n== C. motorns bright dekomponerad ==')
    print('  varians-andel tak (glidande max over 1 slag):', med([r['tak_share'] for r in res]), ' moddjup median', med([r['moddepth'] for r in res]))
    print('  r bright (facit):', med([r['rep_r'] for r in res]), 'lag', med([r['rep_lag'] for r in res]))
    print('  r TAKET ensamt :', med([r['tak_r'] for r in res]), 'lag', med([r['tak_lag'] for r in res]))
    print('  r EMA400 bright:', med([r['lp_r'] for r in res]), 'lag', med([r['lp_lag'] for r in res]))
    print('  r p90 over 2 slag:', med([r['p90_r'] for r in res]), 'lag', med([r['p90_lag'] for r in res]))
    print('\n== lagkurvor (median r per lag ms) ==')
    for key in ('curve_real', 'curve_sim_ceil', 'curve_sim_br'):
        lags = sorted({int(k) for r in res for k in r.get(key, {})})
        print(' ', key, ' '.join(f"{l}:{med([r.get(key, {}).get(str(l), r.get(key, {}).get(l)) for r in res])}" for l in lags))
    print('  klippandel tak>=0.98:', med([r['clip_share'] for r in res]), ' golvandel tak<=0.25:', med([r['floor_share'] for r in res]), ' %/dB:', med([r.get('pct_per_db') for r in res]))
    print('\n== E. motorsim (tak utan pulser = ceil, med pulser = br) ==')
    base = med([r['sim']['base']['ceil_r'] for r in res])
    print('  validering base: sim-bright vs verkligt bright r', med([r['sim']['base']['sim_vs_real_r'] for r in res]), ' sim-tak vs verkligt tak r', med([r['sim']['base']['simtak_vs_realtak_r'] for r in res]), ' lag', med([r['sim']['base']['sim_vs_real_lag'] for r in res]))
    rows = []
    for k in res[0]['sim']:
        rows.append((k, med([r['sim'][k]['ceil_r'] for r in res]), med([r['sim'][k]['ceil_lag'] for r in res]), med([r['sim'][k]['br_r'] for r in res]), med([r['sim'][k]['br_lag'] for r in res]),
                     med([r['sim'][k]['clip'] for r in res]), med([r['sim'][k]['floor'] for r in res]),
                     sum(1 for r in res if (r['sim'][k]['ceil_r'] or 0) > (r['sim']['base']['ceil_r'] or 0))))
    rows.sort(key=lambda x: -(x[1] or 0))
    print(f"  {'variant':28s} {'tak r':>6s} {'lag':>5s} {'br r':>6s} {'lag':>5s} {'klipp':>6s} {'golv':>6s} {'vinner':>7s}")
    for k, rc, lc, rb, lb, cl, fl, w in rows: print(f"  {k:28s} {rc!s:>6s} {lc!s:>5s} {rb!s:>6s} {lb!s:>5s} {cl!s:>6s} {fl!s:>6s} {w:>4d}/{n}")
    print('\n== D. samsta latar (facit-r) ==')
    for r in sorted(res, key=lambda r: (r['rep_r'] or 0))[:12]:
        print(f"  {r['rep_r']!s:>6s} lag {r['rep_lag']!s:>5s} tak_r {r['tak_r']!s:>6s} dyn {r['dyn']:>4} trust {r['trust']} clip {r['clip_share']:.2f} floor {r['floor_share']:.2f} med {r['bright_med']:.2f} p5 {r['bright_p5']:.2f} sim_r {r['sim']['base']['ceil_r']!s:>6s} oracle {r['sim']['anchor_oracle']['ceil_r']!s:>6s} sym {r['sim']['sym_ema300_win18']['ceil_r']!s:>6s} | {r['artist']} - {r['title']}")

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'report':
        report(json.load(open(os.path.join(OUT, 'results.json'))))
    else: main()
