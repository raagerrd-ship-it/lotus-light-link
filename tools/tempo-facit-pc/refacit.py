"""Omfacit: kor estimate() pa nytt over korpus + syntet med aktuell kod (FACIT_REC_EXP i miljon) och jamfor mot det sparade
facit, analysatorns bankvarde (bench-utdata) och katalogen (corpus/<id>.json 'catalog'). Skriver INTE i korpusen (--write gor det).
  set FACIT_REC_EXP=1 && .venv\Scripts\python.exe refacit.py [--bench <bench-utdata.txt>] [--write]"""
import glob, io, json, os, re, sys, time
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import tempo_facit as tf
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
BENCH = arg('--bench'); WRITE = '--write' in sys.argv
TAG = arg('--tag', os.environ.get('FACIT_METHOD', 'evidens') + os.environ.get('FACIT_REC_EXP', '') + os.environ.get('FACIT_RIG_REC_EXP', ''))
def fold(b):
    while b > 180: b /= 2
    while b < 70 and b > 0: b *= 2
    return b
def cls(a, b):
    if not a or not b: return '-'
    r = a / b
    for x, lab in ((1, 'lika'), (2, 'dubbla'), (0.5, 'halva'), (1.5, '3/2'), (2/3, '2/3'), (4/3, '4/3'), (0.75, '3/4')):
        if abs(r / x - 1) < 0.05: return lab
    return 'annat'
an = {}
if BENCH:
    for line in open(BENCH, encoding='utf-8', errors='replace'):
        if line.startswith('korpus ') and not line.startswith(('korpus kick', 'korpus on-beat', 'korpus:')):
            parts = line.split(); name = line[7:49].strip()
            try: an[name] = float(line[57:65])
            except Exception: pass
def read(path):
    y, sr = sf.read(path, dtype='float32', always_2d=True); return y.mean(axis=1), sr
rows = []; t0 = time.time()
for f in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    m = json.load(open(f, encoding='utf-8')); wav = f[:-5] + '.wav'
    if not os.path.exists(wav) or not (m.get('result') or {}).get('bpm'): continue
    y, sr = read(wav); r = tf.estimate(y, sr)
    old = fold(m['result']['bpm']); new = fold(r['bpm']) if r['bpm'] else 0
    name = f"{(m.get('row') or {}).get('artist','')} – {(m.get('row') or {}).get('title','')}"[:40]
    cat = fold((m.get('catalog') or {}).get('bpm') or 0); a = an.get(name.strip(), 0)
    rows.append({'set': 'korpus', 'name': name, 'file': os.path.basename(f), 'cands': r.get('candidates'), 'old': old, 'new': new, 'cat': cat, 'an': a, 'conf': r.get('conf'), 'oldNew': cls(old, new), 'newAn': cls(new, a), 'oldAn': cls(old, a), 'newCat': cls(new, cat), 'oldCat': cls(old, cat)})
    if WRITE and r['bpm']:
        m['result'] = {**m['result'], **{k: v for k, v in r.items() if not k.startswith('_')}, 'prevBpm': m['result']['bpm'], 'refacitAt': int(time.time())}
        json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
for f in sorted(glob.glob(os.path.join(HERE, 'corpus-synth', '*.wav'))):
    facit = float(os.path.basename(f).split('_')[0]); y, sr = read(f); r = tf.estimate(y, sr)
    rows.append({'set': 'synt', 'name': os.path.basename(f)[:-4], 'old': facit, 'new': fold(r['bpm']) if r['bpm'] else 0, 'cat': 0, 'an': 0, 'conf': r.get('conf'), 'oldNew': cls(facit, fold(r['bpm']) if r['bpm'] else 0)})
pad = lambda s, n: str(s).ljust(n)
print(pad('set', 7) + pad('lat', 42) + pad('gammalt', 9) + pad('nytt', 9) + pad('katalog', 9) + pad('analys', 8) + pad('conf', 6) + pad('gam~nytt', 9) + pad('nytt~an', 8) + pad('gam~an', 8) + pad('nytt~kat', 9) + 'gam~kat')
for r in rows: print(pad(r['set'], 7) + pad(r['name'], 42) + pad(f"{r['old']:.1f}", 9) + pad(f"{r['new']:.1f}", 9) + pad(f"{r['cat']:.1f}" if r['cat'] else '-', 9) + pad(f"{r['an']:.1f}" if r['an'] else '-', 8) + pad(f"{r['conf'] or 0:.2f}", 6) + pad(r['oldNew'], 9) + pad(r.get('newAn', '-'), 8) + pad(r.get('oldAn', '-'), 8) + pad(r.get('newCat', '-'), 9) + r.get('oldCat', '-'))
k = [r for r in rows if r['set'] == 'korpus']; s_ = [r for r in rows if r['set'] == 'synt']
cnt = lambda rs, key, val: sum(1 for r in rs if r.get(key) == val)
print(f"\nkorpus n={len(k)}: nytt = gammalt {cnt(k,'oldNew','lika')}; andrade {len(k) - cnt(k,'oldNew','lika')}")
print(f"  mot analysatorn (bank): gammalt facit lika {cnt(k,'oldAn','lika')} -> nytt facit lika {cnt(k,'newAn','lika')} (av {sum(1 for r in k if r['an'])})")
print(f"  mot katalogen: gammalt lika {cnt(k,'oldCat','lika')} -> nytt lika {cnt(k,'newCat','lika')} (av {sum(1 for r in k if r['cat'])} med katalog)")
print(f"synt: {cnt(s_,'oldNew','lika')}/{len(s_)} ratt   ({time.time()-t0:.0f} s)")
json.dump(rows, open(os.path.join(HERE, f'refacit-{TAG}.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('sparat refacit-' + TAG + '.json')
