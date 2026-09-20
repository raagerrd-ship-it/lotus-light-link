"""Fyller pa PC:ns basonsets (analysis.onset.timesS) i befintliga korpus-JSON som saknar dem. Kors en gang."""
import os, io, json, glob, numpy as np, soundfile as sf, librosa
HERE = os.path.dirname(os.path.abspath(__file__)); HOP = 512; n = 0
for jp in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    d = json.load(open(jp, encoding='utf-8')); res = d.get('result') or {}; an = res.setdefault('analysis', {})
    if (an.get('onset') or {}).get('timesS'): continue
    wp = jp[:-5] + '.wav'
    if not os.path.exists(wp): continue
    y, sr = sf.read(wp, dtype='float32', always_2d=True); y = y.mean(axis=1)
    onset_lo = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, fmax=220, n_mels=12)
    on = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time', backtrack=False)
    an.setdefault('onset', {})['timesS'] = [round(float(t), 3) for t in on]; an['onset'].setdefault('onsets', int(len(on)))
    d['result'] = res; json.dump(d, open(jp, 'w', encoding='utf-8'), ensure_ascii=False); n += 1
print('fyllde pa', n, 'poster')
