"""Lokal ML-slagfoljare: Beat This! (Foscarin m.fl., ISMIR 2024) pa CPU i .venv-ml (torch cpu + beat_this). Ger slag + nedslag
ur ljudet utan moln; tempo = median av slagintervallen. Sparas i corpus/<id>.json under 'beatthis' ({bpm, beatsS, downbeatsS,
secs, at}). Kors over korpusen (--limit, --only-allin1 = bara latar som redan har all-in-one, for jamforelse) eller anropas
fran facit-tjansten (track()).
  .venv-ml\\Scripts\\python.exe beatthis_facit.py [--limit N] [--only-allin1] [--force]
Forsta korningen laddar ner modellvikten (final0, ~80 MB) till torch-cachen."""
import glob, json, os, sys, time, warnings
warnings.filterwarnings('ignore')
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
LIMIT = int(arg('--limit', 1000)); ONLY_A1 = '--only-allin1' in sys.argv; FORCE = '--force' in sys.argv
_f2b = None


def tracker():
    global _f2b
    if _f2b is None:
        import torch; torch.set_num_threads(max(1, os.cpu_count() or 2))
        from beat_this.inference import File2Beats
        _f2b = File2Beats(checkpoint_path='final0', device='cpu', dbn=False)
    return _f2b


def track(path):
    """-> {'bpm', 'beatsS', 'downbeatsS', 'secs'}"""
    t0 = time.time(); beats, downs = tracker()(path)
    beats = [float(b) for b in beats]; downs = [float(d) for d in downs]
    # tempo: linjar anpassning slagindex -> tid (modellens slag ar kvantiserade till 20 ms, medianintervallet blir grovt: 125,0/142,9)
    bpm = 0.0
    if len(beats) >= 8:
        b = np.array(beats); k = np.arange(len(b)); A = np.vstack([k, np.ones_like(k)]).T; slope = np.linalg.lstsq(A, b, rcond=None)[0][0]
        bpm = 60 / slope if slope > 0 else 0
    return {'bpm': round(bpm, 2), 'beatsS': [round(b, 3) for b in beats], 'downbeatsS': [round(d, 3) for d in downs], 'secs': round(time.time() - t0, 1)}


if __name__ == '__main__':
    if '--file' in sys.argv:                      # tjanstelage: en fil -> JSON pa stdout (anropas av tempo_facit.py i .venv-ml)
        r = track(arg('--file')); print(json.dumps(r)); sys.exit(0)
    if '--batch' in sys.argv:                     # flera filer (sokvagar en per rad i en textfil) -> en JSON-rad per fil med 'path'; modellen laddas EN gang (mkcorpus_mix.py)
        for path in open(arg('--batch'), encoding='utf-8').read().splitlines():
            path = path.strip()
            if not path: continue
            try: r = track(path); r['path'] = path
            except Exception as e: r = {'path': path, 'error': str(e)[:200]}
            print(json.dumps(r), flush=True)
        sys.exit(0)
    files = sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json')))
    todo = []
    for f in files:
        m = json.load(open(f, encoding='utf-8'))
        if m.get('beatthis') and not FORCE: continue
        if ONLY_A1 and not (m.get('allin1') or {}).get('bpm'): continue
        if os.path.exists(f[:-5] + '.wav'): todo.append(f)
    print(f'{len(files)} korpusfiler, kor {min(LIMIT, len(todo))}', flush=True)
    n = 0
    for f in todo[:LIMIT]:
        try:
            r = track(f[:-5] + '.wav'); r['at'] = int(time.time())
            m = json.load(open(f, encoding='utf-8')); m['beatthis'] = r; json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False); n += 1
            a1 = (m.get('allin1') or {}).get('bpm'); pc = (m.get('result') or {}).get('bpm')
            print(f"  OK {(m.get('row') or {}).get('artist','')[:18]:18} - {(m.get('row') or {}).get('title','')[:20]:20} beatthis {r['bpm']:6.1f} | allin1 {a1 or '-'} | PC {pc} | {len(r['beatsS'])} slag, {r['secs']} s", flush=True)
        except Exception as e:
            print(f'  FEL {os.path.basename(f)}: {str(e)[:140]}', flush=True)
    print(f'klart: {n}')
