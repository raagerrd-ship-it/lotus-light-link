"""SEKTIONSFACIT ur langfangster (2026-09-20 15:25). all-in-ones ETIKETTER pa 100-150 s klipp ar nastan bara 'intro' (modellen
behover hela laten), men dess GRANSER (segmentstart/-slut) ar rimliga strukturgranser. Facit = gransen fran molnet + energirang
per segment raknad ur ljudet: RMS (dB) och basonset-tathet per segment, rang mot latens egna segment -> tier 'high' (oversta
tredjedelen av speltiden efter energi), 'low' (nedersta tredjedelen), 'mid' daremellan; forsta segmentet fore forsta 'high' =
'intro'. Sparas i corpus/<id>.json under result.analysis.sections.derived. Banken jamfor analysatorns realtidssektioner
(high/low/build/break/intro) mot detta: high==high-andel, refrang-recall, falsk-high, gransfel (analysatorns byten inom +-3 s
fran en facitgrans).
  .venv\\Scripts\\python.exe section_facit.py [--force]"""
import glob, json, os, sys
import numpy as np, soundfile as sf, librosa
HERE = os.path.dirname(os.path.abspath(__file__)); FORCE = '--force' in sys.argv


def derive(y, sr, segs):
    segs = [s for s in segs if (s.get('end') or 0) - (s.get('start') or 0) >= 4.0]
    if len(segs) < 2: return None
    hop = 2048; rms = librosa.feature.rms(y=y, frame_length=4096, hop_length=hop)[0]; t = np.arange(len(rms)) * hop / sr
    onset_lo = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512, fmax=220, n_mels=12); tl = np.arange(len(onset_lo)) * 512 / sr
    peaks = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=512, units='time', backtrack=False)
    rows = []
    for s in segs:
        a, b = float(s['start']), float(s['end']); m = (t >= a) & (t < b)
        db = float(20 * np.log10(np.mean(rms[m]) + 1e-6)) if m.any() else -80.0
        dens = float(((peaks >= a) & (peaks < b)).sum() / max(1e-6, b - a))
        rows.append({'start': round(a, 2), 'end': round(b, 2), 'label': s.get('label'), 'db': round(db, 2), 'onsetPerS': round(dens, 2)})
    # energipoang: dB relativt latens median + basonset-tathet relativt median (z-liknande, lika vikt)
    dbs = np.array([r['db'] for r in rows]); dens = np.array([r['onsetPerS'] for r in rows])
    z = (dbs - np.median(dbs)) / max(1.0, np.std(dbs)) + (dens - np.median(dens)) / max(0.3, np.std(dens))
    order = np.argsort(-z); total = sum(r['end'] - r['start'] for r in rows); acc = 0.0
    tier = {}
    for i in order:
        tier[i] = 'high' if acc < total / 3 else ('low' if acc >= 2 * total / 3 else 'mid'); acc += rows[i]['end'] - rows[i]['start']
    seen_high = False
    for i, r in enumerate(rows):
        r['score'] = round(float(z[i]), 2); r['tier'] = tier[i]
        if not seen_high and tier[i] != 'high' and r['start'] < 40: r['tier'] = 'intro'
        if tier[i] == 'high': seen_high = True
    return rows


n = done = 0
for f in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    m = json.load(open(f, encoding='utf-8')); a = ((m.get('result') or {}).get('analysis') or {}); sec = a.get('sections') or {}
    segs = sec.get('segments') or []
    if not segs or not os.path.exists(f[:-5] + '.wav'): continue
    if sec.get('derived') and not FORCE: done += 1; continue
    y, sr = sf.read(f[:-5] + '.wav', dtype='float32'); y = y.mean(axis=1) if y.ndim > 1 else y
    d = derive(y, sr, segs)
    if not d: continue
    sec['derived'] = d; json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False); n += 1
    print(f"  {os.path.basename(f)[:40]:40} {' | '.join(f'{r['start']:.0f}-{r['end']:.0f} {r['tier']}' for r in d)}")
print(f'klart: {n} nya, {done} fanns')
