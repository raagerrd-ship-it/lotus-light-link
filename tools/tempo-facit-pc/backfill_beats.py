"""Fyller pa PC:ns slagtider (result.beatsS) i befintliga korpus-JSON som saknar dem (samma estimate som tjansten)."""
import os, json, glob, sys, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tempo_facit as tf
HERE = os.path.dirname(os.path.abspath(__file__)); n = 0
for jp in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    d = json.load(open(jp, encoding='utf-8')); res = d.get('result') or {}
    if res.get('beatsS'): continue
    wp = jp[:-5] + '.wav'
    if not os.path.exists(wp): continue
    y, sr = sf.read(wp, dtype='float32', always_2d=True); y = y.mean(axis=1)
    r = tf.estimate(y, sr); res['beatsS'] = [round(float(t), 3) for t in r['_beats']]; d['result'] = res
    json.dump(d, open(jp, 'w', encoding='utf-8'), ensure_ascii=False); n += 1
print('fyllde pa slag i', n, 'poster')
