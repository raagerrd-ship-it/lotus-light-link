"""Minikorpus ur ladans inspelningar (2026-09-21) - riktig musik till korbanken (bench.mjs) utan Pi och utan moln.

Kallor (bara lasning): pi-dmx/engine/tools/pop_ladan.wav + megamix_ladan.wav (48 kHz mono, ~10 min var, manga latar)
delas i 30 s-fonster (hopp 30 s); de fem korta filerna (stranden, drickervin, tspel, utandig, real; 45-60 s) tas hela.
Ett fonster blir facit bara om:
  1. ingen latgrans ligger i fonstret - nyhetsdetektor pa klangen (MFCC 2-20, standardiserade, medel 4 s fore mot
     4 s efter, toppar >= median + NOV_K*MAD, minst 15 s isar) - OCH Beat This!-slagen passar ETT stelt grid (residual
     <= RIGID_RES_MS) utan tempohopp mellan fonstrets tredjedelar (> TEMPO_JUMP) - beatmatchade DJ-overgangar fangas
     av klangen, tempobyten av slagen;
  2. kvalitetsgrinden (tempo_facit.audio_quality: brus) slapper igenom och RMS >= MIN_RMS (tystnad mellan latar);
  3. tva roster ar overens: Beat This! (facit, .venv-ml via beatthis_facit.py --batch) och PC:ns stela librosa-grid
     (tempo_facit.estimate_rigid, produktionens PC-facit) inom AGREE_PCT ELLER i oktavforhallande (klass 'oktav').
Facit = Beat This! (result.bpm = beatthis.bpm; result.beatsS = stelt grid genom Beat This!-slagen, som facit-tjansten).
Skriver <id>.wav (48 kHz mono 16-bit) + <id>.json i korbankens schema (result.bpm/beatsS/quality/analysis.onset.timesS,
beatthis, row.artist 'ladan'/title 'pop_ladan@600s', kind 'mix') till corpus-mix/ (data, gitignorerad) + _summary.json
med varje fonsters dom. Komplement till corpus/ (facit-tjanstens snuttar fran Pi:n): inga handelseloggar, inga sektioner.
  .venv\\Scripts\\python.exe mkcorpus_mix.py [--out DIR] [--src DIR] [--dry] [--limit N]
     --dry: bara nyhetsdetektorn (granser per fil), inget Beat This!."""
import os, sys, json, time, subprocess, tempfile, shutil
import numpy as np, soundfile as sf, librosa
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tempo_facit as tf                     # estimate_rigid, audio_quality, rigid_from_beats, fold_an (ingen Pi-kontakt vid import)

arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
SRC = arg('--src', os.environ.get('LOTUS_LADAN_DIR') or r'C:\Users\richa\Desktop\Claude\dmx-control\pi-dmx\engine\tools')
OUT = os.path.abspath(arg('--out', os.path.join(HERE, 'corpus-mix')))
DRY = '--dry' in sys.argv; LIMIT = int(arg('--limit', 10000))
MIXES = ['pop_ladan.wav', 'megamix_ladan.wav']
SHORTS = ['stranden.wav', 'drickervin.wav', 'tspel.wav', 'utandig.wav', 'real.wav']
WIN_S, HOP_S = 30.0, 30.0
NOV_HOP, NOV_CTX_S, NOV_K, NOV_MIN_GAP_S = 4800, 4.0, float(os.environ.get('MIX_NOV_K', '4')), 15.0   # 0,1 s-ramar; 4 s kontext
AGREE_PCT, RIGID_RES_MS, TEMPO_JUMP, MIN_RMS, MIN_BEATS = 0.04, 45.0, 0.05, 0.01, 20
KEEP_STEADY = os.environ.get('MIX_KEEP_STEADY') == '1'   # behall gransfonster nar Beat This!-slagen anda passar ett stelt grid (beatmatchad mix); standard AV = strikt
BT_SCRIPT = os.path.join(HERE, 'beatthis_facit.py')
BT_PY = next((p for p in [os.environ.get('LOTUS_BT_PY') or '', os.path.join(HERE, '.venv-ml', 'Scripts', 'python.exe'),
                          r'C:\Users\richa\Desktop\Claude\lotus-light-link\tools\tempo-facit-pc\.venv-ml\Scripts\python.exe'] if p and os.path.exists(p)), None)   # .venv-ml ar gitignorerad: finns bara i huvudrepot, inte i en worktree
if not BT_PY: sys.exit('hittar ingen .venv-ml (Beat This!) - satt LOTUS_BT_PY')


def read_wav(path):
    """16-bit PCM med tolerant huvud: ladans mixar ar strommade med dataLen 0 (och riffLen 36) -> ta resten av filen (som bench.mjs)."""
    with open(path, 'rb') as f: b = f.read()
    ch = int.from_bytes(b[22:24], 'little'); sr = int.from_bytes(b[24:28], 'little'); bits = int.from_bytes(b[34:36], 'little')
    off = 12; data_off, data_len = 44, len(b) - 44
    while off + 8 <= len(b):
        cid = b[off:off + 4]; ln = int.from_bytes(b[off + 4:off + 8], 'little')
        if cid == b'data':
            data_off = off + 8; data_len = min(ln, len(b) - data_off) if ln else len(b) - data_off; break
        off += 8 + ln + (ln & 1)
    if bits != 16: raise ValueError('bara 16-bit PCM: ' + path)
    y = np.frombuffer(b, dtype='<i2', count=(data_len // (2 * ch)) * ch, offset=data_off).astype(np.float32) / 32768.0
    if ch > 1: y = y.reshape(-1, ch).mean(axis=1)
    return y, sr


def novelty(y, sr):
    """Klangnyhet per 0,1 s: avstand mellan medel-MFCC (2-20, standardiserade over filen) 4 s fore och 4 s efter."""
    m = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20, hop_length=NOV_HOP, n_fft=4096)[1:]
    m = (m - m.mean(axis=1, keepdims=True)) / (m.std(axis=1, keepdims=True) + 1e-9)
    L = int(NOV_CTX_S * sr / NOV_HOP); n = m.shape[1]
    cs = np.concatenate([np.zeros((m.shape[0], 1)), np.cumsum(m, axis=1)], axis=1)
    nov = np.zeros(n)
    for t in range(L, n - L):
        a = (cs[:, t] - cs[:, t - L]) / L; b = (cs[:, t + L] - cs[:, t]) / L
        nov[t] = float(np.sqrt(((a - b) ** 2).mean()))
    times = np.arange(n) * NOV_HOP / sr
    return times, nov


def boundaries(times, nov):
    """Toppar >= median + NOV_K*MAD, lokalt max +-2 s, minst NOV_MIN_GAP_S isar (starkaste forst)."""
    med = float(np.median(nov[nov > 0])); mad = float(np.median(np.abs(nov[nov > 0] - med))) or 1e-6
    thr = med + NOV_K * mad; w = int(2.0 * 48000 / NOV_HOP)
    cand = [i for i in range(w, len(nov) - w) if nov[i] >= thr and nov[i] == nov[i - w:i + w + 1].max()]
    cand.sort(key=lambda i: -nov[i]); keep = []
    for i in cand:
        if all(abs(times[i] - times[j]) >= NOV_MIN_GAP_S for j in keep): keep.append(i)
    return sorted((round(float(times[i]), 1), round(float(nov[i] / thr), 2)) for i in keep), round(thr, 3)


def rigid_check(beats):
    """Passar Beat This!-slagen ETT stelt grid? -> (residual ms, storsta tempohopp mellan tredjedelar)."""
    b = np.asarray(beats, dtype=float)
    if len(b) < MIN_BEATS: return None, None
    k = np.arange(len(b)); A = np.vstack([k, np.ones_like(k)]).T; slope, c0 = np.linalg.lstsq(A, b, rcond=None)[0]
    res = float(np.sqrt(np.mean((b - (c0 + slope * k)) ** 2)) * 1000)
    iv = np.diff(b); n3 = len(iv) // 3
    if n3 < 4: return res, 0.0
    meds = [float(np.median(iv[i * n3:(i + 1) * n3])) for i in range(3)]
    jump = max(abs(x / y - 1) for x in meds for y in meds)
    return res, jump


def agree(bt, pc):
    if not bt or not pc: return 'saknas'
    r = bt / pc
    if abs(r - 1) <= AGREE_PCT: return 'lika'
    if abs(r / 2 - 1) <= AGREE_PCT or abs(r * 2 - 1) <= AGREE_PCT: return 'oktav'
    return 'oense'


def beatthis_batch(paths):
    lst = os.path.join(tempfile.gettempdir(), f'mkcorpus_bt_{os.getpid()}.txt')
    with open(lst, 'w', encoding='utf-8') as f: f.write('\n'.join(paths))
    p = subprocess.run([BT_PY, BT_SCRIPT, '--batch', lst], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=7200)
    os.remove(lst)
    out = {}
    for line in (p.stdout or '').splitlines():
        if line.startswith('{'):
            r = json.loads(line); out[r.pop('path')] = r
    if p.returncode: print('beatthis rc', p.returncode, (p.stderr or '')[-400:])
    return out


def main():
    t_start = time.time(); os.makedirs(OUT, exist_ok=True); tmp = tempfile.mkdtemp(prefix='mkcorpus_')
    cands = []   # {'id','src','t0','lenS','y', 'why':None|str, ...}
    for name in MIXES + SHORTS:
        path = os.path.join(SRC, name)
        if not os.path.exists(path): print('saknas', path); continue
        y, sr = read_wav(path)
        stem = os.path.splitext(name)[0]; dur = len(y) / sr
        if name in MIXES:
            times, nov = novelty(y, sr); bnds, thr = boundaries(times, nov)
            print(f'{name}: {dur:.0f} s, nyhetsgranser {len(bnds)} (troskel {thr}): ' + ' '.join(f'{t}s' for t, _ in bnds))
            starts = np.arange(0.0, dur - WIN_S + 1e-6, HOP_S)
            for t0 in starts:
                inside = [t for t, _ in bnds if t0 < t < t0 + WIN_S]
                cands.append({'id': f'{stem}_{int(t0):04d}', 'src': name, 't0': float(t0), 'lenS': WIN_S, 'sr': sr, 'y': y[int(t0 * sr):int((t0 + WIN_S) * sr)],
                              'why': f'latgrans vid {inside[0]:.0f} s' if inside else None, 'novMax': round(float(nov[(times >= t0) & (times < t0 + WIN_S)].max() / thr), 2), 'boundariesInWindow': inside})
        else:
            cands.append({'id': stem, 'src': name, 't0': 0.0, 'lenS': round(dur, 1), 'sr': sr, 'y': y, 'why': None, 'novMax': None, 'boundariesInWindow': []})
    n_in = len(cands); print(f'{n_in} fonster in (hopp {HOP_S:.0f} s)')
    if DRY: return
    # kvalitet + RMS, sedan tempfiler for Beat This!
    for c in cands[:LIMIT]:                      # Beat This! kors aven pa gransfonster (billigt) sa nyhetsdetektorn kan doms mot slagen i _summary.json
        q = tf.audio_quality(c['y'], c['sr']); rms = float(np.sqrt((c['y'] ** 2).mean())); c['quality'] = q; c['rms'] = round(rms, 4)
        if not q['ok']: c['why'] = 'brus (kvalitetsgrinden)'
        elif rms < MIN_RMS: c['why'] = f'tyst (rms {rms:.3f})'
        else:
            c['tmp'] = os.path.join(tmp, c['id'] + '.wav'); sf.write(c['tmp'], c['y'], c['sr'], subtype='PCM_16')
    todo = [c for c in cands[:LIMIT] if c.get('tmp')]
    print(f'{len(todo)} fonster till Beat This! ...', flush=True); t_bt = time.time()
    bt = beatthis_batch([c['tmp'] for c in todo]); print(f'Beat This! klart {time.time() - t_bt:.0f} s', flush=True)
    kept = 0; agree_n = {'lika': 0, 'oktav': 0, 'oense': 0, 'saknas': 0}
    for c in todo:
        r = bt.get(c['tmp']) or {}
        if 'error' in r or not r: c['why'] = 'beatthis fel: ' + str(r.get('error', 'inget svar'))[:80]; continue
        beats = r.get('beatsS') or []
        res, jump = rigid_check(beats); c['btRes'] = res; c['btJump'] = jump; c['btBpm'] = r.get('bpm')
        c['btSteady'] = bool(res is not None and res <= RIGID_RES_MS and jump <= TEMPO_JUMP)   # slagens egen dom om fonstret (for att doma nyhetsdetektorn)
        if c['why'] and not (KEEP_STEADY and c['btSteady']): continue                          # latgrans enligt klangen: bort (MIX_KEEP_STEADY=1 behaller den om slagen anda ar stadiga = beatmatchad overgang)
        if c['why']: c['boundaryKept'] = True; c['why'] = None
        if res is None: c['why'] = f'for fa slag ({len(beats)})'; continue
        if res > RIGID_RES_MS: c['why'] = f'slagen passar inget stelt grid (residual {res:.0f} ms)'; continue
        if jump > TEMPO_JUMP: c['why'] = f'tempohopp i fonstret ({100 * jump:.0f} %)'; continue
        pc = tf.estimate_rigid(c['y'], c['sr']); cls = agree(r.get('bpm'), pc.get('bpm')); agree_n[cls] += 1
        c['btBpm'] = r.get('bpm'); c['pcBpm'] = pc.get('bpm'); c['voteClass'] = cls
        if cls in ('oense', 'saknas'): c['why'] = f"oense (bt {r.get('bpm')} / pc {pc.get('bpm')})"; continue
        grid = tf.rigid_from_beats(beats); onset_lo = pc.pop('_onset_lo', None); pc.pop('_beats', None)
        peaks = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=c['sr'], hop_length=tf.HOP, units='time', backtrack=False) if onset_lo is not None else []
        title = f"{os.path.splitext(c['src'])[0]}@{int(c['t0'])}s" if c['src'] in MIXES else f"{os.path.splitext(c['src'])[0]} (hel, {c['lenS']:.0f} s)"
        row = {'id': c['id'], 'artist': 'ladan', 'title': title, 'kind': 'mix', 'source': c['src'], 'startS': c['t0'], 'lenS': c['lenS']}
        result = {'id': c['id'], 'kind': 'mix', 'artist': 'ladan', 'title': title, 'bpm': round(float(r['bpm']), 1), 'method': 'beatthis+rigid',
                  'facitVotes': 'bt+pc' if cls == 'lika' else 'bt~pc-oktav', 'voteClass': cls, 'btBpm': r.get('bpm'), 'pcBpm': pc.get('bpm'),
                  'beatsSource': 'beatthis', 'beatsS': [round(float(t), 3) for t in grid], 'btDownbeatsS': r.get('downbeatsS'), 'quality': c['quality'],
                  'rms': c['rms'], 'btRigidResMs': round(res, 1), 'btTempoJump': round(jump, 3), 'novMax': c['novMax'], 'boundariesInWindow': c['boundariesInWindow'], 'boundaryKept': c.get('boundaryKept', False),
                  'pc': {k: v for k, v in pc.items() if not k.startswith('_')},
                  'analysis': {'onset': {'timesS': [round(float(t), 3) for t in peaks]}, 'votes': {'facitVotes': 'bt+pc' if cls == 'lika' else 'bt~pc-oktav', 'voteClass': cls, 'pcBpm': pc.get('bpm'), 'btBpm': r.get('bpm'), 'beatsSource': 'beatthis'}}}
        meta = {'row': row, 'kind': 'mix', 'result': result, 'beatthis': {k: r[k] for k in ('bpm', 'beatsS', 'downbeatsS', 'secs') if k in r} | {'at': int(time.time())},
                'madeBy': 'mkcorpus_mix.py', 'savedAt': time.time()}
        shutil.copyfile(c['tmp'], os.path.join(OUT, c['id'] + '.wav'))
        with open(os.path.join(OUT, c['id'] + '.json'), 'w', encoding='utf-8') as f: json.dump(meta, f, ensure_ascii=False)
        kept += 1; c['why'] = 'OK'
        print(f"  OK {c['id']:22} bt {r['bpm']:6.1f} pc {pc.get('bpm'):6.1f} {cls:5} res {res:4.1f} ms hopp {100 * jump:3.0f} % nyhet {c['novMax']}", flush=True)
    shutil.rmtree(tmp, ignore_errors=True)
    summary = [{k: v for k, v in c.items() if k not in ('y', 'tmp')} for c in cands]
    with open(os.path.join(OUT, '_summary.json'), 'w', encoding='utf-8') as f: json.dump({'madeAt': time.time(), 'nIn': n_in, 'nOut': kept, 'agree': agree_n, 'params': {'winS': WIN_S, 'hopS': HOP_S, 'novK': NOV_K, 'agreePct': AGREE_PCT, 'rigidResMs': RIGID_RES_MS, 'tempoJump': TEMPO_JUMP, 'minRms': MIN_RMS}, 'windows': summary}, f, ensure_ascii=False, indent=1)
    why = {}
    for c in cands: why[c['why'] or 'ej korda'] = why.get(c['why'] or 'ej korda', 0) + 1
    print(f'\n{kept}/{n_in} fonster ut -> {OUT} ({time.time() - t_start:.0f} s). Roster bt/pc: {agree_n}')
    for k, v in sorted(why.items(), key=lambda kv: -kv[1]): print(f'  {v:3} {k}')


if __name__ == '__main__':
    main()
