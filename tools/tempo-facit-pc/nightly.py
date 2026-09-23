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
LIVE = {'LOTUS_TEMPO_EVIDENCE': '1', 'LOTUS_TEMPO_ENV_S': '10', 'LOTUS_KICK_NOGATE': '1', 'LOTUS_KICK_COOLDOWN': '100', 'LOTUS_GRID_PHASE': '1'}   # + gridfas sedan 09-20 12:42 (LOTUS_PHASE_FOLLOW ar motorns flagga, syns ej i banken)
VARIANTS = {'standard': {}, 'live': LIVE, 'evidence': {'LOTUS_TEMPO_EVIDENCE': '1'}, 'ring10': {'LOTUS_TEMPO_ENV_S': '10'}, 'evidlock': {'LOTUS_TEMPO_EVIDLOCK': '1'},
            'live-cd80': dict(LIVE, LOTUS_KICK_COOLDOWN='80'), 'live-cd120': dict(LIVE, LOTUS_KICK_COOLDOWN='120')}
GRID = {'BENCH_GRID': '1'}
SB = os.path.join(HERE, 'scoreboard.jsonl'); MD = os.path.join(HERE, 'scoreboard.md'); DAILY = os.path.join(HERE, 'daily')


def already_done():
    if FORCE or not os.path.exists(SB): return False
    with open(SB, encoding='utf-8') as f:
        return any(json.loads(l).get('date') == TODAY for l in f if l.strip())


def fnum(x):
    """Bankens medianer kan vara 'undefined'/'-' (inga langfangster i urvalet) - 09-23 kraschade hela nattjobbet pa float('undefined')."""
    try: return float(x)
    except (TypeError, ValueError): return None


def run_bench(env_extra):
    env = dict(os.environ, **GRID, **env_extra)
    # encoding utf-8 + errors replace (09-21): cp1252-lasartraden dog pa en latitel (0x81) -> stdout None -> krasch 106 ggr i rad.
    p = subprocess.run(['node', 'bench.mjs'], cwd=HERE, env=env, capture_output=True, encoding='utf-8', errors='replace', timeout=1800)
    out = p.stdout or ''
    res = {'rows': [], 'korpus': None, 'synt': None, 'kick': None, 'onBeat': None, 'sektion': None, 'forutsagelse': None, 'refrang2': None, 'error': p.stderr.strip()[-300:] if p.returncode else ''}
    for line in out.splitlines():
        m = re.match(r'^(korpus|synt): (\d+)/(\d+) ratt \(lika\)\s+klasser (\{.*?\})\s+spann-median (\S+) BPM', line)
        if m: res[m.group(1)] = {'ok': int(m.group(2)), 'n': int(m.group(3)), 'klasser': json.loads(m.group(4)), 'spann': m.group(5)}; continue
        mk = re.match(r'^korpus kick: recall (\S+) precision (\S+) bias (\S+) ms \(n=(\d+)', line)
        if mk: res['kick'] = {'recall': float(mk.group(1)), 'precision': float(mk.group(2)), 'biasMs': float(mk.group(3)), 'n': int(mk.group(4))}; continue
        mb = re.match(r'^korpus on-beat-recall: (\S+) \(median, n=(\d+)', line)
        if mb: res['onBeat'] = {'recall': float(mb.group(1)), 'n': int(mb.group(2))}; continue
        ms_ = re.match(r'^korpus sektionsfacit \(langfangster n=(\d+)\): gransfel-traff median (\S+), high==high andel median (\S+), refrang-recall median (\S+), falsk-high median (\S+)', line)
        if ms_: res['sektion'] = {'n': int(ms_.group(1)), 'gransfel': fnum(ms_.group(2)), 'highEqHigh': fnum(ms_.group(3)), 'recall': fnum(ms_.group(4)), 'falskHigh': fnum(ms_.group(5))}; continue
        mp = re.match(r'^korpus forutsagelse \(langfangster n=(\d+)\): refrangstart forutsedd (\d+)/(\d+) \((\d+) %\), lead median (\S+) s, falska/min median (\S+)', line)
        if mp: res['forutsagelse'] = {'n': int(mp.group(1)), 'hit': int(mp.group(2)), 'tot': int(mp.group(3)), 'leadS': fnum(mp.group(5)), 'falskaPerMin': fnum(mp.group(6))}; continue
        mr = re.match(r'^korpus refrang2 (?:facit=(\w+) )?\(n=(\d+)\): refrang 2 igenkand <=4 s (\d+)/(\d+), <=8 s (\d+)/(\d+), median (\S+) s \| refrang 1 <=4 s (\d+)/(\d+), median (\S+) s \| vers 2 ej high median (\S+) \| refrang 2 forutsedd (\d+)/(\d+)', line)
        if mr: res['refrang2'] = {'facit': mr.group(1) or 'tier', 'n': int(mr.group(2)), 'ch2le4': int(mr.group(3)), 'ch2le8': int(mr.group(5)), 'ch2MedianS': fnum(mr.group(7)), 'ch1le4': int(mr.group(8)), 'ch1MedianS': fnum(mr.group(10)), 'vers2EjHigh': fnum(mr.group(11)), 'ch2Forutsedd': int(mr.group(12))}; continue
        mf = re.match(r'^korpus fas mot Beat This!: on-beat-andel median (\S+), motfas (\d+), i fas (\d+), mellan (\d+) \(n=(\d+)', line)
        if mf: res['phaseBt'] = {'median': float(mf.group(1)), 'motfas': int(mf.group(2)), 'ifas': int(mf.group(3)), 'mellan': int(mf.group(4)), 'n': int(mf.group(5))}; continue
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


def sections_step():
    """SEKTIONSFACIT fore banken (09-22): (1) molnets segment utan derived -> section_facit.derive (energirang); (2) fangster
    (>= LOTUS_SECTION_FACIT_LOCAL_MIN_S, standard 60 s) som saknar derived - molnets dygnstak natt, ingen nyckel, molnfel -
    -> section_facit_local (lokal segmentering, samma tier-definition), skrivs som derived_local + derived (source local).
    LOTUS_SECTION_FACIT_LOCAL=0 stanger av det lokala steget. Molnet ersatter ett lokalt derived nar det senare levererar."""
    out = {'cloud': None, 'local': None}
    sys.path.insert(0, HERE)
    try:
        import section_facit; section_facit.FORCE = False; section_facit.main(); out['cloud'] = 'ok'
    except Exception as e: out['cloud'] = str(e)[:200]
    if os.environ.get('LOTUS_SECTION_FACIT_LOCAL', '1') != '0':
        try:
            import section_facit_local
            out['local'] = section_facit_local.backfill_corpus(min_s=float(os.environ.get('LOTUS_SECTION_FACIT_LOCAL_MIN_S', '60')), verbose=False)
        except Exception as e: out['local'] = str(e)[:200]
    return out


# SEKTIONSBANK (2026-09-22 kvall, agaren: "lagg till all sektionsanalys for de som jobbar i natt"). Pi:ns sektionsflaggor
# (LOTUS_SECTION/GRID_PHASE/SECTION_REPEAT=117 - HALL I SYNK MED PI:NS DROP-INS) korrs pa hela korpusen och pa testhalvan
# (BENCH_SPLIT=test; trainhalvan ar tuning-mangd, aldrig rapport), bade mot energitier-proxyn (derived) och mot det AKUSTISKA
# upprepningsfacitet (repeat_facit.py -> repeats/<id>.json, backfyllt forst for nya langfangster). Bada faciten ar svaga var for
# sig (10/26 overens om refrang 2) - rapportera alltid bada. Baslinje 09-22 test: tier 0/13 <=4 s, vers 2 0,26; akustiskt 11/30,
# median 5,1 s, vers 2 0,46; sektionsfacit 0,27/0,54/0,65/0,52; forutsagelse 4/45 @ 2,0/min. LOTUS_NIGHTLY_SECTIONS=0 stanger av.
SECTION_ENV = {'LOTUS_SECTION': '1', 'LOTUS_GRID_PHASE': '1', 'LOTUS_SECTION_REPEAT': os.environ.get('LOTUS_NIGHTLY_SECTION_REPEAT', '117')}
REPEATS = os.path.join(HERE, 'repeats')
def repeats_step():
    py = os.path.join(HERE, '.venv', 'Scripts', 'python.exe'); py = py if os.path.exists(py) else sys.executable
    if not os.path.exists(os.path.join(HERE, 'repeat_facit.py')): return {'error': 'repeat_facit.py saknas'}
    try:
        p = subprocess.run([py, 'repeat_facit.py', '--out', REPEATS], cwd=HERE, capture_output=True, encoding='utf-8', errors='replace', timeout=3600)
        n = len([f for f in os.listdir(REPEATS) if f.endswith('.json')]) if os.path.isdir(REPEATS) else 0
        return {'filer': n, 'rc': p.returncode, 'tail': (p.stdout or '').strip()[-200:], 'err': (p.stderr or '').strip()[-200:] if p.returncode else ''}
    except Exception as e: return {'error': str(e)[:200]}
def section_bench():
    if os.environ.get('LOTUS_NIGHTLY_SECTIONS') == '0': return None
    out = {'env': SECTION_ENV, 'repeats': repeats_step()}
    keys = ('sektion', 'forutsagelse', 'refrang2', 'error')
    for split in ('alla', 'test'):
        for facit in ('tier', 'repeat'):
            env = dict(SECTION_ENV); env.pop('BENCH_GRID', None)
            if split == 'test': env['BENCH_SPLIT'] = 'test'
            if facit == 'repeat': env['BENCH_REPEATS_DIR'] = REPEATS
            r = run_bench(env); out[f'{split}-{facit}'] = {k: r.get(k) for k in keys}
    return out


def main():
    if already_done(): print('redan kort i dag'); return
    t0 = time.time()
    sections = sections_step()
    bench = {name: run_bench(env) for name, env in VARIANTS.items()}
    sektionsbank = section_bench()
    pi = pi_stats()
    entry = {'date': TODAY, 'at': time.strftime('%H:%M'), 'bench': {k: {kk: v.get(kk) for kk in ('korpus', 'synt', 'kick', 'onBeat', 'phaseBt', 'error')} for k, v in bench.items()}, 'pi': pi, 'sections': sections, 'sektionsbank': sektionsbank, 'sek': round(time.time() - t0)}
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
        pb = b.get('phaseBt')
        if pb: out += f" · fas {pb['ifas']}/{pb['n']}"
        return out
    lines = ['# Resultattavla — analysatorns tempoval mot facit', '', f'Uppdaterad {TODAY} {entry["at"]}. Korpus = riktiga snuttar med PC-facit (växer), syntet = 8 kända tempon. Cell = korpus rätt/n · syntet rätt/n.', '',
             'Cell = korpus rätt/n · syntet rätt/n · on-beat-recall (andel PC-slag med analysatorkick inom ±60 ms) · kickprecision. Bänk = live-läge (BENCH_GRID=1).', '',
             '| datum | standard | live | evidence | ring10 | live-cd80 | live-cd120 | live: dygnets låtar | ok-andel | grid-släp | onset recall | onset precision | nivå r |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for e in hist:
        p = e.get('pi') or {}
        lines.append(f"| {e['date']} | {cell(e,'standard')} | {cell(e,'live')} | {cell(e,'evidence')} | {cell(e,'ring10')} | {cell(e,'live-cd80')} | {cell(e,'live-cd120')} | {p.get('dygn','–')} ({p.get('medFacit','–')} facit) | {p.get('okAndel','–')} | {p.get('gridLagMs','–')} ms | {p.get('onsetRecall','–')} | {p.get('onsetPrecision','–')} | {p.get('levelR','–')} |")
    lines += ['', f"Senaste dygnet: domar {json.dumps(pi.get('domar'), ensure_ascii=False)}; kick-bias {pi.get('kickBiasMs')} ms; nivå-lag {pi.get('levelLagMs')} ms; analysatorns spann inom låt {pi.get('anSpann')} BPM (median); tempoledtrådar ≠ 1: {pi.get('tempoHints')}; dropfångster {pi.get('drops')} {json.dumps(pi.get('dropDomar'))}.",
              '', 'Live = det som kör på Pi:n (tempo-variant.conf), standard = utan flaggor. En variant ska slå live med minst 3 låtar på ≥ 36 korpuslåtar utan att tappa på syntet innan den provas live (drop-in-flagga, backup, återgång). Kickvarianter (cd80/cd120) döms på on-beat-recall utan precisionsförlust > 0,02.']
    sb_ = entry.get('sektionsbank') or {}
    def secline(tag):
        b = sb_.get(tag) or {}; s_ = b.get('sektion') or {}; r2 = b.get('refrang2') or {}; fp = b.get('forutsagelse') or {}
        if not s_ and not r2: return f'{tag}: –'
        return (f"{tag}: high==high {s_.get('highEqHigh','–')} · recall {s_.get('recall','–')} · falsk {s_.get('falskHigh','–')} · gransfel {s_.get('gransfel','–')} (n {s_.get('n','–')}) | "
                f"refrang 2 <=4 s {r2.get('ch2le4','–')}/{r2.get('n','–')}, <=8 s {r2.get('ch2le8','–')}, median {r2.get('ch2MedianS','–')} s · refrang 1 <=4 s {r2.get('ch1le4','–')} · vers 2 ej high {r2.get('vers2EjHigh','–')} · forutsedd {r2.get('ch2Forutsedd','–')} | "
                f"forutsagelse {fp.get('hit','–')}/{fp.get('tot','–')} @ {fp.get('falskaPerMin','–')}/min")
    if sb_: lines += ['', f"Sektioner (Pi-flaggor {json.dumps(sb_.get('env'))}, repeats {json.dumps(sb_.get('repeats'))}):", '', '- ' + secline('test-tier'), '- ' + secline('test-repeat'), '- ' + secline('alla-tier'), '- ' + secline('alla-repeat'),
                 '', 'Tolkning: tier = energirang-proxy (forsta high = refrang 1, andra = refrang 2), repeat = akustisk upprepning (repeat_facit.py). Tuna pa train (BENCH_SPLIT=train), rapportera test; en sektionsandring provas live bara om den vinner pa test mot BADA faciten.']
    with open(MD, 'w', encoding='utf-8') as f: f.write('\n'.join(lines) + '\n')
    print(json.dumps(entry, ensure_ascii=False)[:600]); print('skrev', MD)


if __name__ == '__main__':
    main()
