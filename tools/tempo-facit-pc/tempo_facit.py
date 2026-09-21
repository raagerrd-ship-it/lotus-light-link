"""Facit ur ljudet (2026-09-19). PC:n HAMTAR 30 s-snuttar (48 kHz mono, samma ljud som analysatorn) fran
Pi:n, analyserar i efterhand (icke-kausalt, hela snutten) och skriver facit tillbaka i Pi:ns katalogcache
(PUT /api/tempo/facit). Inga portar oppnas, ingen PC-adress pa Pi:n.

Per snutt: tempo (pa evidens, se estimate), och - nar Pi:n skickat sin handelselogg (<id>.events.json:
kick-ring, gridpulsernas fyrtider, ljusstyrka 10 Hz, drop/riser-flaggor, allt i vaggklocka) - slagfas
(kickbias, pulsfyrning mot PC:ns slag), nivakorrelation ljus-mot-RMS med lag, onset-precision/recall,
dropdom (uppbyggnad -> smallen) och deskriptorer (bas, perkussivitet, dynamik). Allt landar i samma
lardata-rad. Analysatorn ar gemensam med pi-dmx: det som bevisas har ska in i analysatorn.

Kor:  .venv\\Scripts\\python.exe tempo_facit.py [http://192.168.1.174:3051] [--once]
Autostart vid inloggning: tempo_facit.bat via Startup-mappen (LotusTempoFacit.cmd)."""
import io, os, json, sys, time, logging, urllib.request, urllib.parse
import numpy as np, soundfile as sf, librosa

PI = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://192.168.1.174:3051')
CORPUS_DIR = os.environ.get('LOTUS_CORPUS_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpus')
CORPUS_MAX_WAV = int(os.environ.get('LOTUS_CORPUS_MAX') or 600)   # ~1,7 GB; aldsta WAV:erna gallras, JSON (facit+analys) behalls
ONCE = '--once' in sys.argv
POLL_S = 20
HOP = 512
REC_EXP = float(os.environ.get('FACIT_REC_EXP', '0'))   # tackningens vikt i estimate_evidens(); 0 = gamla precision-valet (omfacit 09-20: exp 1 SAMRE, 62->51 mot analysatorn)
RIG_REC_EXP = float(os.environ.get('FACIT_RIG_REC_EXP', '0'))   # tackning i det stela gridet: 1 var SAMRE (27/46 mot katalogen), 0 = ren precision (37/46)
# TRE ROSTER (2026-09-20, "Pi + 2 andra"): PC-facit (stelt grid, librosa) + Beat This! (lokal ML-slagfoljare, .venv-ml,
# beatthis_facit.py --file) ger tempot i majoritet; ar de oense avgor molnet (all-in-one via Replicate, allin1_facit.py) om
# FACIT_CLOUD_TIEBREAK=1 och dygnstaket inte ar natt, annars skickas bpm 0 = osakert facit (Pi:n domer aldrig pa det).
# Fasreferensen (beatsS: pulsfas, onset, korbankens on-beat) = Beat This!-slagen som stelt grid - korpus 09-20: PC-fasen lag
# ett halvt slag fel i 19/87 latar mot Beat This!, medan Beat This! och all-in-one var overens i 49/50.
BT_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.venv-ml', 'Scripts', 'python.exe')
BT_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'beatthis_facit.py')
BT_ON = os.environ.get('FACIT_BEATTHIS', '1') == '1' and os.path.exists(BT_PY)
CLOUD_TIEBREAK = os.environ.get('FACIT_CLOUD_TIEBREAK', '1') == '1'
CLOUD_MAX_PER_DAY = int(os.environ.get('FACIT_CLOUD_MAX', '40'))
_cloud_day = {'d': '', 'n': 0}
METHOD = os.environ.get('FACIT_METHOD', 'rigid')          # PRODUKTION sedan 2026-09-20 12:05: 'rigid' (stelt grid, finsokt period) - 37/46 mot Deezer-katalogen,
                                                          # 83/110 lika analysatorn, 8/8 syntet; 'evidens' (tracker-pinnade slag) gav 31/46, 62/110, 6/8 (kvar for A/B)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('facit')


def http(method: str, path: str, body=None, timeout=30):
    req = urllib.request.Request(PI + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'} if body is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ───────────────────────────── tempo ─────────────────────────────

def estimate(y: np.ndarray, sr: int) -> dict:
    return estimate_rigid(y, sr) if METHOD == 'rigid' else estimate_evidens(y, sr)


def audio_quality(y: np.ndarray, sr: int) -> dict:
    """KVALITETSGRIND (2026-09-20 14:50). Snuttarna 14:13-14:36 var bredbandigt brus (nagot i rummet / mattad mic): spektral
    flathet 0,03-0,06 mot normala 0,002, rolloff 16 kHz mot 9, basandel < 200 Hz 0,2-0,36 mot 0,85 - Beat This! hittade 0 slag,
    librosa och analysatorn gav godtyckliga tempon. Sadana snuttar ska inte bli facit, inte kosta moln och inte laras pa.
    Matt pa de forsta 20 s: flatness (median), basandel. brus = (flatness > 0,02 OCH basandel < 0,5) ELLER flatness > 0,04."""
    seg = y[: int(sr * 20)]
    if len(seg) < sr * 3: return {'ok': True, 'flatness': 0.0, 'bass': 1.0}
    S = np.abs(librosa.stft(seg, n_fft=2048))
    flat = float(np.median(librosa.feature.spectral_flatness(S=S)))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048); p = (S ** 2).sum(axis=1); bass = float(p[freqs < 200].sum() / max(1e-12, p.sum()))
    rms = float(np.sqrt((seg ** 2).mean()))
    # orkestralt utan bas (Red Handed: flatness 0,002, bas 0,29) ar musik, inte brus -> basandelen doms bara ihop med hojd flathet
    return {'ok': not ((flat > 0.02 and bass < 0.5) or flat > 0.04), 'flatness': round(flat, 4), 'bass': round(bass, 2), 'rms': round(rms, 3)}


def fold_an(b: float) -> float:
    """Analysatorns vikning [80,160) - klassjamforelser gors i den."""
    while b >= 160: b /= 2
    while 0 < b < 80: b *= 2
    return b


def tempo_class(a: float, b: float) -> str:
    if not a or not b: return '-'
    r = fold_an(a) / fold_an(b)
    for x, lab in ((1, 'lika'), (2, 'dubbla'), (0.5, 'halva'), (1.5, '3/2'), (2 / 3, '2/3'), (4 / 3, '4/3'), (0.75, '3/4')):
        if abs(r / x - 1) < 0.05: return lab
    return 'annat'


def beatthis_track(wav_bytes: bytes) -> dict | None:
    """Beat This! i .venv-ml som underprocess (torch delar inte venv med librosa). None vid fel/avstangt."""
    if not BT_ON: return None
    import subprocess, tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as fh: fh.write(wav_bytes); tmp = fh.name
        p = subprocess.run([BT_PY, BT_SCRIPT, '--file', tmp], capture_output=True, text=True, timeout=240, encoding='utf-8', errors='replace')
        line = [l for l in p.stdout.splitlines() if l.startswith('{')]
        if p.returncode or not line: log.warning('beatthis misslyckades: rc %s %s', p.returncode, (p.stderr or '')[-200:]); return None
        return json.loads(line[-1])
    except Exception as e:
        log.warning('beatthis fel: %s', e); return None
    finally:
        if tmp:
            try: os.remove(tmp)
            except OSError: pass


def cloud_sections(y: np.ndarray, sr: int):
    """all-in-one pa hela klippet -> [{'start','end','label'}] + tempo. Raknas mot molnets dygnstak. None om ej tillgangligt."""
    if not CLOUD_TIEBREAK: return None
    today = time.strftime('%Y-%m-%d')
    if _cloud_day['d'] != today: _cloud_day['d'] = today; _cloud_day['n'] = 0
    if _cloud_day['n'] >= CLOUD_MAX_PER_DAY: log.info('molnet (sektioner): dygnstaket natt'); return None
    import tempfile, importlib
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    a1 = importlib.import_module('allin1_facit')
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as fh:
        sf.write(fh, y, sr, subtype='PCM_16'); tmp = fh.name
    try:
        res, pt, wall_s = a1.analyse(tmp, deadline_s=300)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    _cloud_day['n'] += 1
    segs = [{'start': round(float(x.get('start') or 0), 2), 'end': round(float(x.get('end') or 0), 2), 'label': str(x.get('label') or '')} for x in (res.get('segments') or [])]
    beats = [float(b) for b in (res.get('beats') or [])]
    log.info('sektionsfacit: %d segment %s (gpu %s s)', len(segs), '/'.join(dict.fromkeys(x['label'] for x in segs)), pt)
    return {'segments': segs, 'bpm': res.get('bpm'), 'beatsS': [round(b, 3) for b in beats], 'downbeatsS': [round(float(d), 3) for d in (res.get('downbeats') or [])], 'predictTimeS': pt}


def rigid_from_beats(beats: list) -> np.ndarray:
    """Stelt grid genom en slaglista (linjar anpassning index -> tid): tar bort 20 ms-kvantiseringen i Beat This!."""
    b = np.asarray(beats, dtype=float)
    if len(b) < 8: return b
    k = np.arange(len(b)); A = np.vstack([k, np.ones_like(k)]).T; slope, c0 = np.linalg.lstsq(A, b, rcond=None)[0]
    if slope <= 0: return b
    n_end = int(np.ceil((b[-1] + 2 * slope) / slope)); return c0 + slope * np.arange(-2, n_end + 1)


def cloud_tiebreak(wav_bytes: bytes) -> float:
    """all-in-one via Replicate nar PC och Beat This! ar oense om tempot. Dygnstak. 0 = inte tillgangligt."""
    if not CLOUD_TIEBREAK: return 0.0
    today = time.strftime('%Y-%m-%d')
    if _cloud_day['d'] != today: _cloud_day['d'] = today; _cloud_day['n'] = 0
    if _cloud_day['n'] >= CLOUD_MAX_PER_DAY: log.info('molnet: dygnstaket %d natt', CLOUD_MAX_PER_DAY); return 0.0
    try:
        import tempfile, importlib
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        a1 = importlib.import_module('allin1_facit')
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as fh: fh.write(wav_bytes); tmp = fh.name
        try:
            res, pt, wall_s = a1.analyse(tmp, deadline_s=150)
        finally:
            try: os.remove(tmp)
            except OSError: pass
        _cloud_day['n'] += 1
        beats = [float(x) for x in (res.get('beats') or [])]
        if len(beats) >= 8:
            b = np.asarray(beats); k = np.arange(len(b)); A = np.vstack([k, np.ones_like(k)]).T; slope = np.linalg.lstsq(A, b, rcond=None)[0][0]
            return 60 / slope if slope > 0 else float(res.get('bpm') or 0)
        return float(res.get('bpm') or 0)
    except Exception as e:
        log.warning('molnet misslyckades: %s', e); return 0.0


def estimate_rigid(y: np.ndarray, sr: int) -> dict:
    """STELT GRID (PRODUKTION sedan 2026-09-20 12:05; var prov). Laxa fran omfacit med tackning: librosas beat_track SNAPPAR slagen mot onseten aven
    nar tempot ar pinnat fel (tightness 400) - da far fel kandidater hog precision OCH hog tackning, och valet blir slump
    bland tempogrambins (93,8/100,5/104,2 dok upp for 20 latar). Har laggs i stallet ett STELT grid: period finsokt
    +-4 % kring varje kandidat (0,2 %-steg), fas i 32 steg, poang = medel av basonset pa slagen (max +-2 ramar) / p95.
    Ett stelt grid med fel tempo driver bort fran slagen inom nagra sekunder -> lag poang; fantomer 3/2, 4/3, 2/3 traffar
    kickarna bara delvis. Tackning (andel basonset-toppar inom +-50 ms fran slag/halvslag) multipliceras in med RIG_REC_EXP.
    Oktav: halvslagskvot >= 0,6 => x2 (som forr). Kandidater: tempogrammets topp-6 + oktavpartner (x2, /2 inom 55-210)."""
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    onset_lo = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, fmax=220, n_mels=12)
    tg = librosa.feature.tempogram(onset_envelope=onset, sr=sr, hop_length=HOP)
    ac = tg.mean(axis=1); bpms = librosa.tempo_frequencies(len(ac), sr=sr, hop_length=HOP)
    mask = np.isfinite(bpms) & (bpms >= 55) & (bpms <= 210); acm, bpmm = ac[mask], bpms[mask]
    cands = []
    for i in np.argsort(acm)[::-1]:
        b = float(bpmm[i])
        if all(abs(b / c['bpm'] - 1) > 0.03 for c in cands): cands.append({'bpm': round(b, 1), 'strength': round(float(acm[i]), 4)})
        if len(cands) >= 6: break
    for c in list(cands):
        for m in (2.0, 0.5):
            b = c['bpm'] * m
            if 55 <= b <= 210 and all(abs(b / d['bpm'] - 1) > 0.03 for d in cands): cands.append({'bpm': round(b, 1), 'strength': 0.0})
    ft = HOP / sr; n = len(onset_lo); env = np.maximum.reduce([np.roll(onset_lo, k) for k in (-2, -1, 0, 1, 2)])   # max +-2 ramar
    norm = float(np.percentile(onset_lo, 95)) or 1.0
    lo_peaks = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time', backtrack=False)
    def grid_mean(p: float, ph: float, half: bool = False) -> float:
        g = np.arange(ph + (p / 2 if half else 0.0), n * ft, p); idx = np.round(g / ft).astype(int); idx = idx[idx < n]
        return float(env[idx].mean()) / norm if len(idx) else 0.0
    def recall_at(p: float, ph: float) -> float:
        if len(lo_peaks) < 4: return 1.0
        grid = np.arange(ph, n * ft, p / 2); idx = np.clip(np.searchsorted(grid, lo_peaks), 1, len(grid) - 1)
        d = np.minimum(np.abs(lo_peaks - grid[idx - 1]), np.abs(lo_peaks - grid[idx])); return float(np.mean(d <= 0.05))
    scored = []
    for c in cands:
        best = (-1.0, 0.0, 0.0)
        for f in np.arange(0.96, 1.0401, 0.002):
            p = 60.0 / (c['bpm'] * f)
            for ph in np.arange(0.0, p, p / 32):
                v = grid_mean(p, ph)
                if v > best[0]: best = (v, p, ph)
        prec, p, ph = best
        if prec <= 0: continue
        bpm_real = 60.0 / p
        if any(abs(bpm_real / s_['bpm'] - 1) <= 0.02 for s_ in scored): continue
        half = grid_mean(p, ph, half=True) / prec; rec = recall_at(p, ph)
        scored.append({'bpm': round(bpm_real, 1), 'cand': c['bpm'], 'beatScore': round(prec, 3), 'recall': round(rec, 3), 'score': round(prec * rec ** RIG_REC_EXP, 3),
                       'halfRatio': round(half, 2), 'strength': c['strength'], '_p': p, '_ph': ph})
    method = 'librosa-' + librosa.__version__ + f'-rigid{RIG_REC_EXP:g}'
    if not scored: return {'bpm': 0, 'candidates': cands, 'method': method, '_beats': np.array([]), '_onset_lo': onset_lo}
    scored.sort(key=lambda s_: s_['score'], reverse=True); best = scored[0]
    bpm_final, octave = best['bpm'], 1
    if best['halfRatio'] >= 0.6 and best['bpm'] * 2 <= 200: bpm_final, octave = best['bpm'] * 2, 2
    conf = best['score'] / scored[1]['score'] if len(scored) > 1 and scored[1]['score'] > 0 else 1.0
    p, ph = best['_p'], best['_ph']; beats = np.arange(ph, n * ft, p / 2 if octave == 2 else p)
    return {'bpm': round(bpm_final, 1), 'bpmTracker': best['bpm'], 'octave': octave, 'halfRatio': best['halfRatio'], 'beatScore': best['beatScore'],
            'conf': round(float(conf), 2), 'beats': int(len(beats)), 'candidates': [{k: v for k, v in s_.items() if not k.startswith('_')} for s_ in scored[:6]],
            'method': method, '_beats': beats, '_onset_lo': onset_lo}


def estimate_evidens(y: np.ndarray, sr: int) -> dict:
    """Tempo ur hela snutten, valt pa EVIDENS - inte pa trackerns prior.

    Klicktest 09-19 (kick 80 Hz + hi-hat): librosas beat_track med default-prior gav 168 -> 112,5 (2/3),
    86 -> 114,8 (4/3), 172 -> 114,8 (2/3) och la slagen pa hi-hatsen vid 123 - exakt fallorna som fallde
    forra sessionens egna autokorrelationer (137,5 och 60 om samma 90-lat). Tempogrammets kandidatlista
    hade daremot ofta ratt varde. Darfor: for varje topp-kandidat pinnas tempot (bpm=), slagen laggs ut,
    och BAS-onset (< 220 Hz, dar kickar finns men inte hi-hats) mats PA slagen. Fantomer traffar kickarna
    bara var annan/tredje gang -> lag median; vinnaren ar den vars slag sitter pa kickarna. Oktaven (x2)
    avgors sedan av halvslagstestet i basbandet pa vinnaren. 6/6 pa syntetiskt test. Allt rapporteras."""
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
    # TACKNING (2026-09-20): beatScore ar en PRECISION (median pa slagen) och belonar glesa fantomgrid: for latar med
    # bas pa varje attondel (eurodance, disco polo, dansband) traffar 2/3-gridet (90,7 for 136) bara bastoner och vann
    # (Dr. Alban 90,7 mot 137,2: 0,75 mot 0,47) fast det forklarar bara var tredje baston. Darfor vags en RECALL in:
    # andelen basonsets (toppar i onset_lo) som ligger inom +-50 ms fran ett slag eller halvslag i kandidatens grid.
    # Fantomer 3/2, 4/3 och 2/3 tacker 1/3-1/2 av onseten, ratt tempo nastan alla. Vikt: score = beatScore * recall**REC_EXP.
    lo_peaks = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time', backtrack=False)
    def recall_at(bts: np.ndarray) -> float:
        if len(lo_peaks) < 4 or len(bts) < 2: return 1.0
        grid = np.sort(np.concatenate([bts, (bts[:-1] + bts[1:]) / 2]))
        idx = np.clip(np.searchsorted(grid, lo_peaks), 1, len(grid) - 1)
        d = np.minimum(np.abs(lo_peaks - grid[idx - 1]), np.abs(lo_peaks - grid[idx]))
        return float(np.mean(d <= 0.05))
    scored = []
    for c in cands:
        try:
            _, bts = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, bpm=c['bpm'], tightness=400, units='time')
        except Exception:
            continue
        if len(bts) < 6: continue
        bpm_real = float(60 / np.median(np.diff(bts)))
        if abs(bpm_real / c['bpm'] - 1) > 0.08: continue           # trackern gled ivag fran kandidaten
        if any(abs(bpm_real / s['bpm'] - 1) <= 0.03 for s in scored): continue   # samma verkliga tempo
        s_beat = strength_at(onset_lo, bts) / lo_norm
        s_half = strength_at(onset_lo, (bts[:-1] + bts[1:]) / 2) / lo_norm
        rec = recall_at(bts)
        scored.append({'bpm': round(bpm_real, 1), 'cand': c['bpm'], 'beatScore': round(s_beat, 3), 'recall': round(rec, 3),
                       'score': round(s_beat * rec ** REC_EXP, 3),
                       'halfRatio': round(s_half / s_beat, 2) if s_beat > 0 else 0.0, 'strength': c['strength'], '_beats': bts})
    method = 'librosa-' + librosa.__version__ + ('-evidens' if REC_EXP == 0 else f'-evidens-tackning{REC_EXP:g}')
    if not scored:
        return {'bpm': 0, 'candidates': cands, 'method': method, '_beats': np.array([]), '_onset_lo': onset_lo}
    scored.sort(key=lambda s: s['score'], reverse=True)
    best = scored[0]
    bpm_final, octave = best['bpm'], 1
    if best['halfRatio'] >= 0.6 and best['bpm'] * 2 <= 200: bpm_final, octave = best['bpm'] * 2, 2
    conf = best['score'] / scored[1]['score'] if len(scored) > 1 and scored[1]['score'] > 0 else 1.0
    beats = best['_beats']
    if octave == 2 and len(beats) > 1:               # slaggridet i det valda tempot: mittpunkter in
        beats = np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2]))
    return {'bpm': round(bpm_final, 1), 'bpmTracker': best['bpm'], 'octave': octave, 'halfRatio': best['halfRatio'],
            'beatScore': best['beatScore'], 'conf': round(float(conf), 2), 'beats': int(len(beats)),
            'candidates': [{k: v for k, v in s.items() if k != '_beats'} for s in scored[:5]], 'method': method,
            '_beats': beats, '_onset_lo': onset_lo}


# ───────────────────────── analyser mot handelseloggen ─────────────────────────

def _wall(ev: dict, t_s) -> np.ndarray:
    return ev['captureStartWallMs'] + np.asarray(t_s, dtype=float) * 1000.0


def _nearest_offsets(ts: np.ndarray, grid: np.ndarray) -> np.ndarray:
    ts = np.asarray(ts, dtype=float)
    if not len(ts) or len(grid) < 2: return np.array([])
    idx = np.clip(np.searchsorted(grid, ts), 1, len(grid) - 1)
    lo, hi = grid[idx - 1], grid[idx]
    return np.where(np.abs(ts - lo) < np.abs(ts - hi), ts - lo, ts - hi)


def phase_analysis(ev: dict, beats_s: np.ndarray, bpm: float) -> dict:
    """Slagfas: analysatorns kickar och motorns gridpulser mot PC:ns slag (vaggklocka). Negativt = fore slaget.
    Bara on-beat-traffar (|offset| < slag/4) raknas - attondelskickar ligger vid ett halvt slag och skulle
    gora medianen meningslos. pulse.medianMs ar FYRTIDEN i ticken; lampan lyser ~beatLeadMs + BLE-latens senare."""
    if bpm <= 0 or len(beats_s) < 4: return {'n': 0}
    per = 60000.0 / bpm
    grid = _wall(ev, beats_s)
    lo, hi = grid[0] - per, grid[-1] + per

    beat = ev.get('beat') or {}
    lead = float(beat.get('leadMs') or 0)

    def stats(src, shift=0.0):
        """shift: forvantad fyrtid relativt slaget. Pulser SKA fyra vid -lead, sa de mats mot slag - lead;
        annars klipper on-beat-fonstret (+-slag/4) bort just den regionen (rokprov 09-19: 'gridLag 122')."""
        ts = np.array([t for t in (src or []) if lo <= t <= hi], dtype=float)
        o = _nearest_offsets(ts + shift, grid)
        on = o[np.abs(o) < per / 4] if len(o) else o
        r = {'n': int(len(o)), 'onBeat': int(len(on)), 'offBeatShare': round(1 - len(on) / len(o), 2) if len(o) else None}
        if len(on) >= 3:
            r.update({'medianMs': round(float(np.median(on)) - shift, 1), 'iqrMs': round(float(np.percentile(on, 75) - np.percentile(on, 25)), 1)})
        return r
    kick = stats(ev.get('kicks'))
    pulse = stats(ev.get('pulses'), shift=lead)          # medianMs = fyrtid mot slaget (forvantat -lead)
    grid_lag = round(pulse['medianMs'] + lead, 1) if 'medianMs' in pulse else None   # +x = gridet x ms sent
    return {'kick': kick, 'pulse': pulse, 'gridLagMs': grid_lag, 'leadMs': lead, 'gridBpm': beat.get('bpm'), 'pcBpm': round(bpm, 1)}


def level_analysis(y: np.ndarray, sr: int, ev: dict) -> dict:
    """Ljusstyrka (10 Hz, = lastSent.pct) mot snuttens RMS i dB, normaliserade 5-95 %. Korskorrelation
    for lag -0,5..+1,5 s (positivt = ljuset ligger EFTER ljudet). lagMs + r = styrkekanalens synk och trohet."""
    br = np.array(ev.get('bright') or [], dtype=float)
    if len(br) < 30: return {'n': int(len(br))}
    hop = int(sr * 0.1)
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop, center=True)[0]
    t_ms = ev['captureStartWallMs'] + np.arange(len(rms)) * 100.0
    db = 20 * np.log10(rms + 1e-6)
    p5, p95 = np.percentile(db, 5), np.percentile(db, 95)
    a_all = (db - p5) / max(1e-6, p95 - p5)
    bt, bv = br[:, 0], br[:, 1]
    idx = np.clip(np.searchsorted(bt, t_ms), 0, len(bt) - 1)
    b_all = bv[idx]; valid = np.abs(bt[idx] - t_ms) < 150
    best = None
    for lag in range(-5, 16):
        if lag >= 0: a, c, v = a_all[:len(a_all) - lag], b_all[lag:], valid[lag:]
        else: a, c, v = a_all[-lag:], b_all[:len(b_all) + lag], valid[:len(b_all) + lag]
        a, c = a[v], c[v]
        if len(a) < 30 or a.std() < 1e-6 or c.std() < 1e-6: continue
        r = float(np.corrcoef(a, c)[0, 1])
        if best is None or r > best[1]: best = (lag * 100, r)
    r0 = float(np.corrcoef(a_all[valid], b_all[valid])[0, 1]) if valid.sum() > 30 and b_all[valid].std() > 1e-6 else 0.0
    return {'n': int(len(br)), 'lagMs': best[0] if best else None, 'r': round(best[1], 3) if best else None, 'r0': round(r0, 3),
            'brightMin': round(float(bv.min()), 2), 'brightMedian': round(float(np.median(bv)), 2), 'brightMax': round(float(bv.max()), 2),
            'audioDynDb': round(float(p95 - p5), 1)}


def onset_analysis(ev: dict, onset_lo: np.ndarray, sr: int) -> dict:
    """PC:ns icke-kausala basonsets (< 220 Hz) mot analysatorns kick-ring: precision (kickar med onset inom
    50 ms), recall (onsets som fick en kick) och tidsbias (kick - onset, positivt = analysatorn sen)."""
    on = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time', backtrack=False)
    ow = np.sort(_wall(ev, on)) if len(on) else np.array([])
    kicks = np.array(sorted(ev.get('kicks') or []), dtype=float)
    if len(ow) >= 2: kicks = kicks[(kicks >= ow[0] - 200) & (kicks <= ow[-1] + 200)]
    if len(ow) < 2 or len(kicks) < 2: return {'onsets': int(len(ow)), 'kicks': int(len(kicks))}
    d = _nearest_offsets(kicks, ow); hit = np.abs(d) <= 50
    d2 = _nearest_offsets(ow, kicks); rec = float((np.abs(d2) <= 50).mean())
    return {'onsets': int(len(ow)), 'kicks': int(len(kicks)), 'precision': round(float(hit.mean()), 2), 'recall': round(rec, 2),
            'biasMs': round(float(np.median(d[hit])), 1) if hit.any() else None, 'onsetsPerS': round(len(ow) / max(1e-6, (ow[-1] - ow[0]) / 1000), 2),
            'timesS': [round(float(t), 3) for t in on]}   # PC:ns basonsets (s fran snuttens start) - korbankens kick-facit


def drop_scan(y: np.ndarray, sr: int, ev: dict) -> dict:
    """Drop = svacka (bas <= 50 % av topp i 3,5 s) foljd av att basen och helheten kommer tillbaka (>= 60 %)
    inom 2 s. score = viktat steg. For 'drop'-fangster: smallen ska ligga vid prerollSamples (= 15 s) -
    ratt om en kandidat ligger inom 2,5 s, falsk om inget steg finns alls, annars osaker. For tempo-snuttar
    listas kandidater sa missade drops kan hittas mot realtidsdetektorns dropCount-andringar (flags)."""
    hop = int(sr * 0.1)
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=hop)); freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
    bass = S[freqs < 150].sum(axis=0); full = S.sum(axis=0)
    bn = bass / (np.percentile(bass, 95) + 1e-9); fn = full / (np.percentile(full, 95) + 1e-9)
    n = len(bn); best = (0.0, 0); cands = []
    for t in range(40, n - 20):
        before, after = bn[t - 40:t - 5].mean(), bn[t:t + 20].mean()
        fb, fa = fn[t - 40:t - 5].mean(), fn[t:t + 20].mean()
        score = (after - before) * 0.7 + (fa - fb) * 0.3
        if before <= 0.5 and after >= 0.6 and score > 0.35: cands.append((t / 10.0, round(float(score), 2)))
        if score > best[0]: best = (float(score), t)
    merged = []
    for t, s in cands:
        if merged and t - merged[-1][0] < 3:
            if s > merged[-1][1]: merged[-1] = (t, s)
        else: merged.append((t, s))
    out = {'bestScore': round(best[0], 2), 'bestAtS': round(best[1] / 10.0, 1), 'candidates': [{'atS': t, 'score': s} for t, s in merged[:5]]}
    if ev.get('kind') == 'drop':
        e = ev.get('prerollSamples', 0) / sr; near = [c for c in merged if abs(c[0] - e) <= 2.5]
        out.update({'eventAtS': round(e, 1), 'verdict': 'ratt' if near else ('falsk' if best[0] < 0.2 else 'osaker'), 'nearScore': near[0][1] if near else None})
    fl = ev.get('flags') or []
    out['realtimeDropsAtS'] = [round((f[0] - ev['captureStartWallMs']) / 1000.0, 1) for i, f in enumerate(fl) if i and f[1] != fl[i - 1][1]]
    return out


def descriptors(y: np.ndarray, sr: int, onset_lo: np.ndarray) -> dict:
    """Vilken sorts musik: spektral tyngdpunkt, basandel (< 150 Hz), perkussivitet (HPSS pa 20 s),
    dynamik (RMS p95/p50 i dB), basonsets per sekund."""
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=1024)); freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    tot = S.sum() + 1e-9
    cent = float(librosa.feature.spectral_centroid(S=S, sr=sr).mean())
    yh, yp = librosa.effects.hpss(y[: sr * 20])
    perc = float((yp ** 2).sum() / ((yh ** 2).sum() + (yp ** 2).sum() + 1e-9))
    rms = librosa.feature.rms(y=y)[0]
    dyn = float(20 * np.log10((np.percentile(rms, 95) + 1e-9) / (np.percentile(rms, 50) + 1e-9)))
    on = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time')
    return {'centroidHz': int(round(cent)), 'bassRatio': round(float(S[freqs < 150].sum() / tot), 3), 'percussive': round(perc, 3),
            'dynamicsDb': round(dyn, 1), 'bassOnsetsPerS': round(len(on) / (len(y) / sr), 2)}


# ───────────────────────────── loop ─────────────────────────────

def process_one(row: dict) -> bool:
    key, artist, title = row.get('key', ''), row.get('artist', ''), row.get('title', '')
    sid, kind = row.get('id') or key, row.get('kind') or 'tempo'
    t0 = time.time()
    wav = http('GET', '/api/tempo/snippet?key=' + urllib.parse.quote(sid), timeout=60)
    y, sr = sf.read(io.BytesIO(wav), dtype='float32', always_2d=True)
    y = y.mean(axis=1)
    ev = None
    if row.get('hasEvents'):
        try: ev = json.loads(http('GET', '/api/tempo/events?key=' + urllib.parse.quote(sid), timeout=30))
        except Exception as e: log.warning('handelselogg saknas for %s: %s', sid, e)
    if ev and ev.get('truncatedAtMs') and ev.get('captureStartWallMs'):          # langfangst: laten bytte mitt i - klipp
        cut = (float(ev['truncatedAtMs']) - float(ev['captureStartWallMs'])) / 1000.0
        if cut >= 20: y = y[:int(cut * sr)]; log.info('langfangst klippt vid %.0f s (latbyte)', cut)
    if len(y) < sr * 5:
        log.info('for kort snutt (%.1f s) for %s - %s', len(y) / sr, artist, title)
        http('PUT', '/api/tempo/facit', {'id': sid, 'key': key, 'kind': kind, 'artist': artist, 'title': title, 'bpm': 0, 'method': 'kort'})
        return False
    q = audio_quality(y, sr)
    if not q['ok']:
        log.info('BRUS: %s - %s (flatness %s, basandel %s, rms %s) - inget facit, inget moln, sparas markt', artist, title, q['flatness'], q['bass'], q.get('rms'))
        http('PUT', '/api/tempo/facit', {'id': sid, 'key': key, 'kind': kind, 'artist': artist, 'title': title, 'bpm': 0, 'method': 'brus', 'analysis': {'quality': q}})
        try:
            os.makedirs(CORPUS_DIR, exist_ok=True); safe = sid.replace('|', '__').replace('#', '_')
            with open(os.path.join(CORPUS_DIR, safe + '.wav'), 'wb') as f: f.write(wav)
            with open(os.path.join(CORPUS_DIR, safe + '.json'), 'w', encoding='utf-8') as f:
                json.dump({'row': row, 'result': {'bpm': 0, 'method': 'brus', 'quality': q}, 'events': ev, 'savedAt': time.time()}, f, ensure_ascii=False)
        except Exception as e: log.warning('brus-snutt kunde inte sparas: %s', e)
        return False
    r = estimate(y, sr)
    beats, onset_lo = r.pop('_beats'), r.pop('_onset_lo')
    r['quality'] = q
    # ── TRE ROSTER ────────────────────────────────────────────────────────────
    bt = beatthis_track(wav)
    if bt and not (40 <= float(bt.get('bpm') or 0) <= 220): log.info('beatthis orimligt tempo %s - ignoreras', bt.get('bpm')); bt = None   # 'Age of War': 6,2 BPM
    r['pcBpm'] = r.get('bpm', 0); r['btBpm'] = (bt or {}).get('bpm', 0); r['beatsSource'] = 'pc'
    if bt and bt.get('bpm'):
        c = tempo_class(r['pcBpm'], bt['bpm']); r['voteClass'] = c
        if c == 'lika': r['facitVotes'] = 'pc+bt'
        else:
            a1 = cloud_tiebreak(wav); r['cloudBpm'] = round(a1, 2)
            if a1 and tempo_class(a1, r['pcBpm']) == 'lika': r['facitVotes'] = 'pc+moln'
            elif a1 and tempo_class(a1, bt['bpm']) == 'lika': r['facitVotes'] = 'bt+moln'; r['bpm'] = round(bt['bpm'], 1)
            else: r['facitVotes'] = 'oense'; r['bpm'] = 0     # osakert facit: Pi:n domer inte, ingen ledtrad
        if len(bt.get('beatsS') or []) >= 8 and r['bpm'] and tempo_class(bt['bpm'], r['bpm']) == 'lika':
            # BT-slag som fasreferens BARA nar BT:s tempo = det slutliga facit (14:36: BT 114,6 mot facit 125,2 gav fel grid for fasen)
            beats = rigid_from_beats(bt['beatsS']); r['beatsSource'] = 'beatthis'
            r['btDownbeatsS'] = bt.get('downbeatsS')
    else:
        r['facitVotes'] = 'pc'
    r['beatsS'] = [round(float(t), 3) for t in beats]    # PC:ns slagtider (s) - korbankens on-beat-recall for kickdetektorn
    analysis = {}
    if ev:
        try: analysis['phase'] = phase_analysis(ev, beats, (60.0 / float(np.median(np.diff(beats))) if len(beats) >= 8 else r.get('bpm', 0)))   # slagens eget tempo (BT-grid), aven vid osakert facit
        except Exception as e: analysis['phase'] = {'error': str(e)}
        try: analysis['level'] = level_analysis(y, sr, ev)
        except Exception as e: analysis['level'] = {'error': str(e)}
        try: analysis['onset'] = onset_analysis(ev, onset_lo, sr)
        except Exception as e: analysis['onset'] = {'error': str(e)}
        try: analysis['drop'] = drop_scan(y, sr, ev)
        except Exception as e: analysis['drop'] = {'error': str(e)}
    if 'onset' not in analysis:
        try:
            on = librosa.onset.onset_detect(onset_envelope=onset_lo, sr=sr, hop_length=HOP, units='time', backtrack=False)
            analysis['onset'] = {'onsets': int(len(on)), 'timesS': [round(float(t), 3) for t in on]}
        except Exception as e: analysis['onset'] = {'error': str(e)}
    try: analysis['descr'] = descriptors(y, sr, onset_lo)
    except Exception as e: analysis['descr'] = {'error': str(e)}
    if kind == 'section':
        # SEKTIONSFACIT (09-20): all-in-one pa hela langfangsten -> etiketter (intro/verse/chorus/bridge/inst/outro/break/solo).
        # Analysatorns egna realtidssektioner ligger i handelseloggens flags (kolumn 6-9). Banken jamfor (bench.mjs).
        try:
            segs = cloud_sections(y, sr)
            if segs is not None: analysis['sections'] = segs
        except Exception as e: analysis['sections'] = {'error': str(e)}
    # rosterna foljer med i analysen (Pi:ns cache sparar bara 'pc' = analysis, inte losa falt pa r)
    analysis['votes'] = {k: r.get(k) for k in ('facitVotes', 'voteClass', 'pcBpm', 'btBpm', 'cloudBpm', 'beatsSource') if k in r}
    analysis['beatsSource'] = r.get('beatsSource'); analysis['facitVotes'] = r.get('facitVotes')
    r.update({'id': sid, 'key': key, 'kind': kind, 'artist': artist, 'title': title, 'analysis': analysis})
    http('PUT', '/api/tempo/facit', r)
    # KORPUS (09-19): snutten + handelselogg + resultat sparas pa PC:n (Pi:n raderar sin kopia nar facit
    # kommit). Det ar datasetet for att trimma analysatorns tempoval offline - delad med pi-dmx.
    try:
        os.makedirs(CORPUS_DIR, exist_ok=True)
        safe = sid.replace('|', '__').replace('#', '_')
        with open(os.path.join(CORPUS_DIR, safe + '.wav'), 'wb') as f: f.write(wav)
        with open(os.path.join(CORPUS_DIR, safe + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'row': row, 'result': r, 'events': ev, 'savedAt': time.time()}, f, ensure_ascii=False)
        wavs = sorted((os.path.join(CORPUS_DIR, f) for f in os.listdir(CORPUS_DIR) if f.endswith('.wav')), key=os.path.getmtime)
        for old in wavs[:max(0, len(wavs) - CORPUS_MAX_WAV)]:
            os.remove(old); log.info('korpus gallrad: %s', os.path.basename(old))
    except Exception as e:
        log.warning('korpus kunde inte sparas for %s: %s', sid, e)
    ph, lv, on, dr = analysis.get('phase', {}), analysis.get('level', {}), analysis.get('onset', {}), analysis.get('drop', {})
    log.info('%s [%s] %s - %s: %.1f BPM [%s pc %s bt %s moln %s] (tracker %s x%s halvkvot %s conf %s) | kick %s ms (n=%s) puls %s ms | niva lag %s ms r %s | onset p %s r %s bias %s | drop %s %s | %.1f s',
             kind, sid.split('#')[-1] if '#' in sid else '-', artist, title, r.get('bpm', 0), r.get('facitVotes'), r.get('pcBpm'), r.get('btBpm'), r.get('cloudBpm', '-'), r.get('bpmTracker'), r.get('octave'), r.get('halfRatio'), r.get('conf'),
             (ph.get('kick') or {}).get('medianMs'), (ph.get('kick') or {}).get('onBeat'), (ph.get('pulse') or {}).get('medianMs'),
             lv.get('lagMs'), lv.get('r'), on.get('precision'), on.get('recall'), on.get('biasMs'),
             dr.get('verdict', '-'), dr.get('candidates', [])[:2], time.time() - t0)
    return True


NIGHTLY_TRIED = {}


def nightly_if_due():
    """Lager 1 (09-19): korbank over varianter + dygnsstatistik -> scoreboard.md, en gang per dygn efter 04:30.
    Schemalaggaren nekade utan admin; tjansten kor anda alltid och autostartar, sa den ager nattjobbet."""
    lt = time.localtime()
    if lt.tm_hour < 4 or (lt.tm_hour == 4 and lt.tm_min < 30): return
    today = time.strftime('%Y-%m-%d'); sb = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scoreboard.jsonl')
    try:
        if os.path.exists(sb):
            with open(sb, encoding='utf-8') as f:
                if any(json.loads(l).get('date') == today for l in f if l.strip()): return
    except Exception:
        pass
    if NIGHTLY_TRIED.get('date') == today: return   # ett forsok per dygn (09-21: kraschande nattjobb korde om var 3:e minut hela formiddagen); morgonagenten kor --force
    NIGHTLY_TRIED['date'] = today
    log.info('nattjobb: korbank + dygnsstatistik (%s)', today)
    try:
        import subprocess
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nightly.py'), PI], capture_output=True, encoding='utf-8', errors='replace', timeout=7200)
        log.info('nattjobb klart (rc %s): %s', p.returncode, ((p.stdout or '') + (p.stderr or '')).strip()[-300:])
    except Exception as e:
        log.warning('nattjobb misslyckades: %s', e)


def main():
    log.info('facit-tjanst mot %s (librosa %s)', PI, librosa.__version__)
    while True:
        try:
            rows = json.loads(http('GET', '/api/tempo/snippets', timeout=15))
            for row in rows:
                try: process_one(row)
                except Exception as e: log.warning('snutt %s: %s', row.get('id') or row.get('key'), e)
        except Exception as e:
            log.warning('Pi:n nas inte: %s', e)
        nightly_if_due()
        if ONCE: break
        time.sleep(POLL_S)


if __name__ == '__main__':
    main()
