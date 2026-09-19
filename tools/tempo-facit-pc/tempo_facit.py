"""Facit ur ljudet (2026-09-19). PC:n HAMTAR 30 s-snuttar (48 kHz mono, samma ljud som analysatorn) fran
Pi:n, raknar tempo i efterhand med librosa (icke-kausalt, hela snutten, inget [80,160)-fonster) och skriver
facit tillbaka i Pi:ns katalogcache (PUT /api/tempo/facit). Inga portar oppnas, ingen PC-adress pa Pi:n.

Tre roster per snutt: beat-trackerns tempo, prior-tempot (tempogram + lognormal prior) och medianen av
slagintervallen. `agree` = alla tre inom 3 %. `conf` = tempogrammets topp / tvaa. Kandidaterna (topp 5) foljer
med sa oktav-/fantomklasser kan granskas mot analysatorn i lardatan.

Kor:  .venv\\Scripts\\python.exe tempo_facit.py [http://192.168.1.174:3051] [--once]
Autostart vid inloggning: tempo_facit.bat via Schemalaggaren (se README)."""
import io, json, sys, time, logging, urllib.request, urllib.parse
import numpy as np, soundfile as sf, librosa

PI = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://192.168.1.174:3051')
ONCE = '--once' in sys.argv
POLL_S = 20
HOP = 512
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('facit')


def http(method: str, path: str, body=None, timeout=30):
    req = urllib.request.Request(PI + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'} if body is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def estimate(y: np.ndarray, sr: int) -> dict:
    """Tempo ur hela snutten, valt pa EVIDENS - inte pa trackerns prior.

    Klicktest 09-19 (kick 80 Hz + hi-hat): librosas beat_track med default-prior gav 168 -> 112,5 (2/3),
    86 -> 114,8 (4/3), 172 -> 114,8 (2/3) och la slagen pa hi-hatsen vid 123 - exakt fallorna som fallde
    forra sessionens egna autokorrelationer (137,5 och 60 om samma 90-lat). Tempogrammets kandidatlista
    hade daremot ofta ratt varde. Darfor: for varje topp-kandidat pinnas tempot (bpm=), slagen laggs ut,
    och BAS-onset (< 220 Hz, dar kickar finns men inte hi-hats) mats PA slagen. Fantomer traffar kickarna
    bara var annan/tredje gang -> lag median; vinnaren ar den vars slag sitter pa kickarna. Oktaven (x2)
    avgors sedan av halvslagstestet i basbandet pa vinnaren. Allt rapporteras sa reglerna kan granskas."""
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    onset_lo = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, fmax=220, n_mels=12)
    tg = librosa.feature.tempogram(onset_envelope=onset, sr=sr, hop_length=HOP)
    ac = tg.mean(axis=1)
    bpms = librosa.tempo_frequencies(len(ac), sr=sr, hop_length=HOP)
    mask = np.isfinite(bpms) & (bpms >= 55) & (bpms <= 210)
    acm, bpmm = ac[mask], bpms[mask]
    cands = []
    for i in np.argsort(acm)[::-1]:          # topp 6 distinkta toppar (>= 3 % isar)
        b = float(bpmm[i])
        if all(abs(b / c['bpm'] - 1) > 0.03 for c in cands):
            cands.append({'bpm': round(b, 1), 'strength': round(float(acm[i]), 4)})
        if len(cands) >= 6: break

    def strength_at(env: np.ndarray, ts: np.ndarray) -> float:
        idx = np.clip(np.round(ts * sr / HOP).astype(int), 0, len(env) - 1)
        return float(np.median(env[idx])) if len(idx) else 0.0
    lo_norm = float(np.percentile(onset_lo, 95)) or 1.0
    scored = []
    for c in cands:
        try:
            _, bts = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, bpm=c['bpm'], tightness=400, units='time')
        except Exception:
            continue
        if len(bts) < 6: continue
        bpm_real = float(60 / np.median(np.diff(bts)))
        if abs(bpm_real / c['bpm'] - 1) > 0.08: continue           # trackern gled ivag fran kandidaten
        if any(abs(bpm_real / s['bpm'] - 1) <= 0.03 for s in scored): continue   # samma verkliga tempo som en redan poangsatt
        s_beat = strength_at(onset_lo, bts) / lo_norm
        s_half = strength_at(onset_lo, (bts[:-1] + bts[1:]) / 2) / lo_norm
        scored.append({'bpm': round(bpm_real, 1), 'cand': c['bpm'], 'beatScore': round(s_beat, 3),
                       'halfRatio': round(s_half / s_beat, 2) if s_beat > 0 else 0.0, 'strength': c['strength'], '_beats': bts})
    method = 'librosa-' + librosa.__version__ + '-evidens'
    if not scored:
        return {'bpm': 0, 'candidates': cands, 'method': method}
    scored.sort(key=lambda s: s['beatScore'], reverse=True)
    best = scored[0]
    bpm_final, octave = best['bpm'], 1
    if best['halfRatio'] >= 0.6 and best['bpm'] * 2 <= 200: bpm_final, octave = best['bpm'] * 2, 2
    conf = best['beatScore'] / scored[1]['beatScore'] if len(scored) > 1 and scored[1]['beatScore'] > 0 else 1.0
    return {'bpm': round(bpm_final, 1), 'bpmTracker': best['bpm'], 'octave': octave, 'halfRatio': best['halfRatio'],
            'beatScore': best['beatScore'], 'conf': round(float(conf), 2), 'beats': int(len(best['_beats'])),
            'candidates': [{k: v for k, v in s.items() if k != '_beats'} for s in scored[:5]], 'method': method}


def process_one(row: dict) -> bool:
    key, artist, title = row.get('key', ''), row.get('artist', ''), row.get('title', '')
    t0 = time.time()
    wav = http('GET', '/api/tempo/snippet?key=' + urllib.parse.quote(key), timeout=60)
    y, sr = sf.read(io.BytesIO(wav), dtype='float32', always_2d=True)
    y = y.mean(axis=1)
    if len(y) < sr * 5:
        log.info('for kort snutt (%.1f s) for %s - %s', len(y) / sr, artist, title)
        http('PUT', '/api/tempo/facit', {'key': key, 'artist': artist, 'title': title, 'bpm': 0, 'method': 'kort'})
        return False
    r = estimate(y, sr)
    r.update({'key': key, 'artist': artist, 'title': title})
    http('PUT', '/api/tempo/facit', r)
    log.info('%s - %s: %.1f BPM (tracker %s, oktav x%s, halvkvot %s, slagpoang %s, conf %s) kandidater %s  [%.1f s ljud @%d, %.1f s berakning]',
             artist, title, r['bpm'], r.get('bpmTracker'), r.get('octave'), r.get('halfRatio'), r.get('beatScore'), r.get('conf'),
             ' '.join(f"{c['bpm']}:{c.get('beatScore', '-')}" for c in r['candidates']), len(y) / sr, sr, time.time() - t0)
    return True


def main():
    log.info('facit-tjanst mot %s (librosa %s)', PI, librosa.__version__)
    while True:
        try:
            rows = json.loads(http('GET', '/api/tempo/snippets', timeout=15))
            for row in rows:
                try: process_one(row)
                except Exception as e: log.warning('snutt %s: %s', row.get('key'), e)
        except Exception as e:
            log.warning('Pi:n nas inte: %s', e)
        if ONCE: break
        time.sleep(POLL_S)


if __name__ == '__main__':
    main()
