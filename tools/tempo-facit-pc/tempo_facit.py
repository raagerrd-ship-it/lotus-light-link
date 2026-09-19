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


# ───────────────────────────── tempo ─────────────────────────────

def estimate(y: np.ndarray, sr: int) -> dict:
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
        scored.append({'bpm': round(bpm_real, 1), 'cand': c['bpm'], 'beatScore': round(s_beat, 3),
                       'halfRatio': round(s_half / s_beat, 2) if s_beat > 0 else 0.0, 'strength': c['strength'], '_beats': bts})
    method = 'librosa-' + librosa.__version__ + '-evidens'
    if not scored:
        return {'bpm': 0, 'candidates': cands, 'method': method, '_beats': np.array([]), '_onset_lo': onset_lo}
    scored.sort(key=lambda s: s['beatScore'], reverse=True)
    best = scored[0]
    bpm_final, octave = best['bpm'], 1
    if best['halfRatio'] >= 0.6 and best['bpm'] * 2 <= 200: bpm_final, octave = best['bpm'] * 2, 2
    conf = best['beatScore'] / scored[1]['beatScore'] if len(scored) > 1 and scored[1]['beatScore'] > 0 else 1.0
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

    def stats(src):
        ts = np.array([t for t in (src or []) if lo <= t <= hi], dtype=float)
        o = _nearest_offsets(ts, grid)
        on = o[np.abs(o) < per / 4] if len(o) else o
        r = {'n': int(len(o)), 'onBeat': int(len(on)), 'offBeatShare': round(1 - len(on) / len(o), 2) if len(o) else None}
        if len(on) >= 3:
            r.update({'medianMs': round(float(np.median(on)), 1), 'iqrMs': round(float(np.percentile(on, 75) - np.percentile(on, 25)), 1)})
        return r
    beat = ev.get('beat') or {}
    return {'kick': stats(ev.get('kicks')), 'pulse': stats(ev.get('pulses')), 'leadMs': beat.get('leadMs'), 'gridBpm': beat.get('bpm'), 'pcBpm': round(bpm, 1)}


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
            'biasMs': round(float(np.median(d[hit])), 1) if hit.any() else None, 'onsetsPerS': round(len(ow) / max(1e-6, (ow[-1] - ow[0]) / 1000), 2)}


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
    if len(y) < sr * 5:
        log.info('for kort snutt (%.1f s) for %s - %s', len(y) / sr, artist, title)
        http('PUT', '/api/tempo/facit', {'id': sid, 'key': key, 'kind': kind, 'artist': artist, 'title': title, 'bpm': 0, 'method': 'kort'})
        return False
    r = estimate(y, sr)
    beats, onset_lo = r.pop('_beats'), r.pop('_onset_lo')
    analysis = {}
    if ev:
        try: analysis['phase'] = phase_analysis(ev, beats, r.get('bpm', 0))
        except Exception as e: analysis['phase'] = {'error': str(e)}
        try: analysis['level'] = level_analysis(y, sr, ev)
        except Exception as e: analysis['level'] = {'error': str(e)}
        try: analysis['onset'] = onset_analysis(ev, onset_lo, sr)
        except Exception as e: analysis['onset'] = {'error': str(e)}
        try: analysis['drop'] = drop_scan(y, sr, ev)
        except Exception as e: analysis['drop'] = {'error': str(e)}
    try: analysis['descr'] = descriptors(y, sr, onset_lo)
    except Exception as e: analysis['descr'] = {'error': str(e)}
    r.update({'id': sid, 'key': key, 'kind': kind, 'artist': artist, 'title': title, 'analysis': analysis})
    http('PUT', '/api/tempo/facit', r)
    ph, lv, on, dr = analysis.get('phase', {}), analysis.get('level', {}), analysis.get('onset', {}), analysis.get('drop', {})
    log.info('%s [%s] %s - %s: %.1f BPM (tracker %s x%s halvkvot %s conf %s) | kick %s ms (n=%s) puls %s ms | niva lag %s ms r %s | onset p %s r %s bias %s | drop %s %s | %.1f s',
             kind, sid.split('#')[-1] if '#' in sid else '-', artist, title, r.get('bpm', 0), r.get('bpmTracker'), r.get('octave'), r.get('halfRatio'), r.get('conf'),
             (ph.get('kick') or {}).get('medianMs'), (ph.get('kick') or {}).get('onBeat'), (ph.get('pulse') or {}).get('medianMs'),
             lv.get('lagMs'), lv.get('r'), on.get('precision'), on.get('recall'), on.get('biasMs'),
             dr.get('verdict', '-'), dr.get('candidates', [])[:2], time.time() - t0)
    return True


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
        if ONCE: break
        time.sleep(POLL_S)


if __name__ == '__main__':
    main()
