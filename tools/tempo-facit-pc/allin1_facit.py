"""Referensfacit ur all-in-one-modellen (sakemin/all-in-one-music-structure-analyzer, ISMIR 2023) via Replicate — samma modell
som showanalysen (pi/tools/analyseSongs.mjs) anvande. Ger slag, nedslag, tempo och sektioner ur ljudet med ML-tracker; battre an
librosa (PC-facit) och oberoende av bade analysatorn och katalogen. Resultatet sparas i corpus/<id>.json under 'allin1'
({bpm, bpmScalar, beatsS, downbeatsS, segments, predictTimeS, at}). Kostar pengar per korning (GPU-sekunder) — kors for hand,
aldrig automatiskt: EN gang per korpuslat.
  .venv\\Scripts\\python.exe allin1_facit.py [--limit N] [--dry] [--only <delstrang>]
Nyckeln lases ur %USERPROFILE%\\.lotus-secrets\\replicate.token (kopia av Pi:ns /var/lib/pi-control-center/apps/lotus-light/replicate.token)
eller REPLICATE_TOKEN. Den skrivs ALDRIG ut och ligger aldrig i repot."""
import glob, json, os, sys, time, urllib.request, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://api.replicate.com/v1'
VERSION = '001b4137be6ac67bdc28cb5cffacf128b874f530258d033de23121e785cb7290'   # samma version som analyseSongs.mjs
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
LIMIT = int(arg('--limit', 5)); DRY = '--dry' in sys.argv; ONLY = (arg('--only') or '').lower()
TOKEN = os.environ.get('REPLICATE_TOKEN') or (open(os.path.expanduser('~/.lotus-secrets/replicate.token')).read().strip() if os.path.exists(os.path.expanduser('~/.lotus-secrets/replicate.token')) else '')
if not TOKEN and not DRY: sys.exit('ingen Replicate-nyckel')
HDR = {'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'lotus-facit/1.0'}   # Cloudflare (1010) blockerar urllib utan User-Agent


def req(method, url, data=None, headers=None, timeout=60):
    h = dict(HDR); h.update(headers or {})
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp: return json.load(resp)


def upload(path):
    boundary = '----lotus' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="content"; filename="{os.path.basename(path)}"\r\n'
            'Content-Type: audio/wav\r\n\r\n').encode() + open(path, 'rb').read() + f'\r\n--{boundary}--\r\n'.encode()
    d = req('POST', API + '/files', body, {'Content-Type': 'multipart/form-data; boundary=' + boundary}, timeout=120)
    return (d.get('urls') or {}).get('get')


def analyse(path, deadline_s=900):
    url = upload(path)
    if not url: raise RuntimeError('uppladdningen gav ingen URL')
    pred = req('POST', API + '/predictions', json.dumps({'version': VERSION, 'input': {'music_input': url, 'visualize': False, 'sonify': False}}).encode(), {'Content-Type': 'application/json'})
    t0 = time.time()
    while pred.get('status') in ('starting', 'processing'):
        if time.time() - t0 > deadline_s: raise RuntimeError('tidsgrans')
        time.sleep(5); pred = req('GET', pred['urls']['get'])
    if pred.get('status') != 'succeeded': raise RuntimeError('korning ' + str(pred.get('status')) + ' ' + str(pred.get('error'))[:120])
    out = pred['output'] if isinstance(pred['output'], list) else [pred['output']]
    ju = next((u for u in out if isinstance(u, str) and u.endswith('.json')), out[0])
    with urllib.request.urlopen(urllib.request.Request(ju, headers={'User-Agent': 'lotus-facit/1.0'}), timeout=60) as r: res = json.load(r)
    if isinstance(res, list): res = res[0]
    return res, (pred.get('metrics') or {}).get('predict_time'), time.time() - t0




if __name__ == '__main__':   # BUGG 13:31: import fran tempo_facit korde hela korpusloopen (5 molnkorningar, 315 s) - nu bara som skript
    files = sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json')))
    todo = []
    for f in files:
        m = json.load(open(f, encoding='utf-8'))
        if m.get('allin1') and m['allin1'].get('bpm'): continue
        if not os.path.exists(f[:-5] + '.wav'): continue
        name = f"{(m.get('row') or {}).get('artist', '')} - {(m.get('row') or {}).get('title', '')}"
        if ONLY and ONLY not in name.lower(): continue
        todo.append((f, name))
    print(f'{len(files)} korpusfiler, {len(todo)} utan allin1, kor {min(LIMIT, len(todo))}{" (torrkorning)" if DRY else ""}')
    ok = fail = 0; tot_pt = 0.0
    for f, name in todo[:LIMIT]:
        if DRY: print('  ', name[:70]); continue
        try:
            res, pt, wall = analyse(f[:-5] + '.wav')
            beats = [float(x) for x in (res.get('beats') or [])]; downs = [float(x) for x in (res.get('downbeats') or [])]
            iv = sorted(b - a for a, b in zip(beats, beats[1:])); bpm_beats = 60 / iv[len(iv) // 2] if len(iv) >= 8 else 0
            m = json.load(open(f, encoding='utf-8'))
            m['allin1'] = {'bpm': round(bpm_beats or float(res.get('bpm') or 0), 2), 'bpmScalar': res.get('bpm'), 'beatsS': [round(b, 3) for b in beats], 'downbeatsS': [round(b, 3) for b in downs],
                           'beatPositions': res.get('beat_positions'), 'segments': [{'start': s.get('start'), 'end': s.get('end'), 'label': s.get('label')} for s in (res.get('segments') or [])],
                           'predictTimeS': pt, 'version': VERSION[:12], 'at': int(time.time())}
            json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
            ok += 1; tot_pt += float(pt or 0)
            pc = (m.get('result') or {}).get('bpm'); cat = (m.get('catalog') or {}).get('bpm')
            print(f"  OK {name[:44]:44} allin1 {m['allin1']['bpm']:6.1f} (skalar {res.get('bpm')}) | PC {pc} | katalog {cat or '-'} | {len(beats)} slag, gpu {pt}s, vagg {wall:.0f}s", flush=True)
        except Exception as e:
            fail += 1; print(f'  FEL {name[:44]}: {str(e)[:140]}', flush=True)
    print(f'klart: {ok} ok, {fail} fel, gpu-tid totalt {tot_pt:.0f} s')
