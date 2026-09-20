"""Nattjobb (lager 1, ingen LLM): korbanken over varianter + dygnsstatistik ur Pi:ns cache -> resultattavla.
Kors av facit-tjansten en gang per dygn efter 04:30 (tempo_facit.py), eller for hand:
  .venv\\Scripts\\python.exe nightly.py [--force] [--pi http://192.168.1.174:3051]
Skriver: scoreboard.jsonl (en rad per dygn), scoreboard.md (senaste 14 dygn), daily/<datum>.json (allt)."""
import json, os, re, subprocess, sys, time, statistics as S, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
PI = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://192.168.1.174:3051')
FORCE = '--force' in sys.argv
TODAY = time.strftime('%Y-%m-%d')
# 'live' = det som kor pa Pi:n (tempo-variant.conf: evidensval + 10 s ring + kickgrind av + cooldown 100, sedan 2026-09-20 10:23).
# 'standard' = gamla vagen utan flaggor. BENCH_GRID=1 pa alla = som motorn (analysatorn grindar kickar mot sitt grid).
LIVE = {'LOTUS_TEMPO_EVIDENCE': '1', 'LOTUS_TEMPO_ENV_S': '10', 'LOTUS_KICK_NOGATE': '1', 'LOTUS_KICK_COOLDOWN': '100'}
VARIANTS = {'standard': {}, 'live': LIVE, 'evidence': {'LOTUS_TEMPO_EVIDENCE': '1'}, 'ring10': {'LOTUS_TEMPO_ENV_S': '10'}, 'evidlock': {'LOTUS_TEMPO_EVIDLOCK': '1'},
            'live-cd80': dict(LIVE, LOTUS_KICK_COOLDOWN='80'), 'live-cd120': dict(LIVE, LOTUS_KICK_COOLDOWN='120')}
GRID = {'BENCH_GRID': '1'}
SB = os.path.join(HERE, 'scoreboard.jsonl'); MD = os.path.join(HERE, 'scoreboard.md'); DAILY = os.path.join(HERE, 'daily')


def already_done():
    if FORCE or not os.path.exists(SB): return False
    with open(SB, encoding='utf-8') as f:
        return any(json.loads(l).get('date') == TODAY for l in f if l.strip())


def run_bench(env_extra):
    env = dict(os.environ, **GRID, **env_extra)
    p = subprocess.run(['node', 'bench.mjs'], cwd=HERE, env=env, capture_output=True, text=True, timeout=1800)
    out = p.stdout
    res = {'rows': [], 'korpus': None, 'synt': None, 'kick': None, 'onBeat': None, 'error': p.stderr.strip()[-300:] if p.returncode else ''}
    for line in out.splitlines():
        m = re.match(r'^(korpus|synt): (\d+)/(\d+) ratt \(lika\)\s+klasser (\{.*?\})\s+spann-median (\S+) BPM', line)
        if m: res[m.group(1)] = {'ok': int(m.group(2)), 'n': int(m.group(3)), 'klasser': json.loads(m.group(4)), 'spann': m.group(5)}; continue
        mk = re.match(r'^korpus kick: recall (\S+) precision (\S+) bias (\S+) ms \(n=(\d+)', line)
        if mk: res['kick'] = {'recall': float(mk.group(1)), 'precision': float(mk.group(2)), 'biasMs': float(mk.group(3)), 'n': int(mk.group(4))}; continue
        mb = re.match(r'^korpus on-beat-recall: (\S+) \(median, n=(\d+)', line)
        if mb: res['onBeat'] = {'recall': float(mb.group(1)), 'n': int(mb.group(2))}; continue
        elif line.startswith(('korpus ', 'synt   ')):
            parts = line.split()
            try: res['rows'].append({'set': parts[0], 'namn': line[7:49].strip(), 'facit': float(parts[-6]), 'analys': float(parts[-5]), 'ra': float(parts[-4]), 'klass': parts[-2], 'kvot': float(parts[-1])})
            except Exception: pass
    return res


def pi_stats():
    try:
        rows = json.load(urllib.request.urlopen(PI + '/api/tempo/cache', timeout=20))
    except Exception as e:
        return {'error': str(e)}
    cut = (time.time() - 24 * 3600) * 1000
    day = [r for r in rows if (r.get('pcAt') or r.get('learnAt') or 0) >= cut]
    med = lambda xs: round(S.median(xs), 1) if xs else None
    g = lambda r, *ks: (lambda d: d)(r)  # placeholder
    def dig(r, *ks):
        d = r
        for k in ks:
            d = d.get(k) if isinstance(d, dict) else None
            if d is None: return None
        return d
    verd = {}
    for r in day:
        v = r.get('verdictEnd') or ('utan facit' if not r.get('bpm') else 'ingen dom')
        verd[v] = verd.get(v, 0) + 1
    return {
        'rader': len(rows), 'dygn': len(day), 'medPc': sum(1 for r in day if r.get('pc')), 'medFacit': sum(1 for r in day if r.get('bpm')),
        'domar': verd,
        # ok-andel = andel av DOMDA rader (facit finns) dar analysatorn lag ratt ('ok'); oktav/fantom raknas som fel klass.
        'okAndel': round(verd.get('ok', 0) / max(1, sum(v for k, v in verd.items() if k not in ('utan facit', 'ingen dom'))), 2),
        'domda': sum(v for k, v in verd.items() if k not in ('utan facit', 'ingen dom')),
        'gridLagMs': med([dig(r, 'pc', 'phase', 'gridLagMs') for r in day if isinstance(dig(r, 'pc', 'phase', 'gridLagMs'), (int, float))]),
        'kickBiasMs': med([dig(r, 'pc', 'phase', 'kick', 'medianMs') for r in day if isinstance(dig(r, 'pc', 'phase', 'kick', 'medianMs'), (int, float))]),
        'onsetRecall': med([dig(r, 'pc', 'onset', 'recall') for r in day if isinstance(dig(r, 'pc', 'onset', 'recall'), (int, float))]),
        'onsetPrecision': med([dig(r, 'pc', 'onset', 'precision') for r in day if isinstance(dig(r, 'pc', 'onset', 'precision'), (int, float))]),
        'levelLagMs': med([dig(r, 'pc', 'level', 'lagMs') for r in day if isinstance(dig(r, 'pc', 'level', 'lagMs'), (int, float))]),
        'levelR': med([dig(r, 'pc', 'level', 'r') for r in day if isinstance(dig(r, 'pc', 'level', 'r'), (int, float))]),
        'anSpann': med([(r['learn']['bpmMax'] - r['learn']['bpmMin']) for r in day if r.get('learn') and r['learn'].get('bpmMax') and r['learn'].get('bpmMin')]),
        'tempoHints': sum(1 for r in rows if (r.get('tempoHint') or {}).get('ratio') not in (None, 1)),
        'drops': sum(len(r.get('dropEvents') or []) for r in rows),
        'dropDomar': {k: sum(1 for r in rows for d in (r.get('dropEvents') or []) if d.get('verdict') == k) for k in ('ratt', 'falsk', 'osaker')},
        'latar': [f"{r.get('artist','')} – {r.get('title','')}" for r in day][:40],
    }


def main():
    if already_done(): print('redan kort i dag'); return
    t0 = time.time()
    bench = {name: run_bench(env) for name, env in VARIANTS.items()}
    pi = pi_stats()
    entry = {'date': TODAY, 'at': time.strftime('%H:%M'), 'bench': {k: {kk: v[kk] for kk in ('korpus', 'synt', 'kick', 'onBeat', 'error')} for k, v in bench.items()}, 'pi': pi, 'sek': round(time.time() - t0)}
    os.makedirs(DAILY, exist_ok=True)
    with open(os.path.join(DAILY, TODAY + '.json'), 'w', encoding='utf-8') as f: json.dump({'entry': entry, 'benchRows': {k: v['rows'] for k, v in bench.items()}}, f, ensure_ascii=False, indent=1)
    with open(SB, 'a', encoding='utf-8') as f: f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    # Markdown, senaste 14 dygn
    with open(SB, encoding='utf-8') as f: hist = [json.loads(l) for l in f if l.strip()][-14:]
    def cell(e, v):
        b = (e.get('bench') or {}).get(v) or {}; k = b.get('korpus'); s = b.get('synt'); ob = b.get('onBeat'); kk = b.get('kick')
        if not k: return '–'
        out = f"{k['ok']}/{k['n']}" + (f" · {s['ok']}/{s['n']}" if s else '')
        if ob and kk: out += f" · slag {ob['recall']:.2f} p {kk['precision']:.2f}"
        return out
    lines = ['# Resultattavla — analysatorns tempoval mot facit', '', f'Uppdaterad {TODAY} {entry["at"]}. Korpus = riktiga snuttar med PC-facit (växer), syntet = 8 kända tempon. Cell = korpus rätt/n · syntet rätt/n.', '',
             'Cell = korpus rätt/n · syntet rätt/n · on-beat-recall (andel PC-slag med analysatorkick inom ±60 ms) · kickprecision. Bänk = live-läge (BENCH_GRID=1).', '',
             '| datum | standard | live | evidence | ring10 | live-cd80 | live-cd120 | live: dygnets låtar | ok-andel | grid-släp | onset recall | onset precision | nivå r |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for e in hist:
        p = e.get('pi') or {}
        lines.append(f"| {e['date']} | {cell(e,'standard')} | {cell(e,'live')} | {cell(e,'evidence')} | {cell(e,'ring10')} | {cell(e,'live-cd80')} | {cell(e,'live-cd120')} | {p.get('dygn','–')} ({p.get('medFacit','–')} facit) | {p.get('okAndel','–')} | {p.get('gridLagMs','–')} ms | {p.get('onsetRecall','–')} | {p.get('onsetPrecision','–')} | {p.get('levelR','–')} |")
    lines += ['', f"Senaste dygnet: domar {json.dumps(pi.get('domar'), ensure_ascii=False)}; kick-bias {pi.get('kickBiasMs')} ms; nivå-lag {pi.get('levelLagMs')} ms; analysatorns spann inom låt {pi.get('anSpann')} BPM (median); tempoledtrådar ≠ 1: {pi.get('tempoHints')}; dropfångster {pi.get('drops')} {json.dumps(pi.get('dropDomar'))}.",
              '', 'Live = det som kör på Pi:n (tempo-variant.conf), standard = utan flaggor. En variant ska slå live med minst 3 låtar på ≥ 36 korpuslåtar utan att tappa på syntet innan den provas live (drop-in-flagga, backup, återgång). Kickvarianter (cd80/cd120) döms på on-beat-recall utan precisionsförlust > 0,02.']
    with open(MD, 'w', encoding='utf-8') as f: f.write('\n'.join(lines) + '\n')
    print(json.dumps(entry, ensure_ascii=False)[:600]); print('skrev', MD)


if __name__ == '__main__':
    main()
