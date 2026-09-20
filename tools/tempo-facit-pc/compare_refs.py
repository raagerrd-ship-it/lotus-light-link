"""Jamfor referenserna mot varandra pa korpusen: PC-facit (stelt grid, librosa), all-in-one (Replicate, 'allin1'), Beat This!
(lokalt, 'beatthis'), Deezer-katalogen ('catalog'). Tempo = klass efter vikning till [80,160); fas = andel av den enas slag inom
+-1/4 slag fran den andras (samma oktav). Anvands for att valja domare: vem ar 'Pi + 2 andra'?
  .venv\\Scripts\\python.exe compare_refs.py"""
import glob, json, os, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))


def fold(b):
    while b >= 160: b /= 2
    while 0 < b < 80: b *= 2
    return b


def cls(a, b):
    if not a or not b: return '-'
    r = fold(a) / fold(b)
    for x, lab in ((1, 'lika'), (2, 'dubbla'), (0.5, 'halva'), (1.5, '3/2'), (2 / 3, '2/3'), (4 / 3, '4/3'), (0.75, '3/4')):
        if abs(r / x - 1) < 0.05: return lab
    return 'annat'


def phase(a, b):
    """andel av a-slagen inom +-1/4 slag fran narmaste b-slag; None om olika period (>4 %) eller for fa slag"""
    a = np.array([x for x in a if x > 1.0]); b = np.array(b)
    if len(a) < 6 or len(b) < 8: return None
    pa = np.median(np.diff(a)); pb = np.median(np.diff(b))
    if abs(pa / pb - 1) >= 0.04: return None
    idx = np.clip(np.searchsorted(b, a), 1, len(b) - 1); d = np.minimum(np.abs(a - b[idx - 1]), np.abs(a - b[idx]))
    return float(np.mean(d < pb / 4))


rows = []
for f in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    m = json.load(open(f, encoding='utf-8'))
    pc = m.get('result') or {}; a1 = m.get('allin1') or {}; bt = m.get('beatthis') or {}; cat = (m.get('catalog') or {}).get('bpm') or 0
    rows.append({'name': f"{(m.get('row') or {}).get('artist', '')[:16]} - {(m.get('row') or {}).get('title', '')[:14]}",
                 'pc': pc.get('bpm') or 0, 'a1': a1.get('bpm') or 0, 'bt': bt.get('bpm') or 0, 'cat': cat,
                 'pcB': pc.get('beatsS') or [], 'a1B': a1.get('beatsS') or [], 'btB': bt.get('beatsS') or []})
pairs = [('bt', 'a1'), ('pc', 'a1'), ('pc', 'bt')]
print(f"{len(rows)} korpusrader | med allin1 {sum(1 for r in rows if r['a1'])}, beatthis {sum(1 for r in rows if r['bt'])}, katalog {sum(1 for r in rows if r['cat'])}")
for x, y in pairs:
    rs = [r for r in rows if r[x] and r[y]]
    c = collections.Counter(cls(r[x], r[y]) for r in rs)
    ph = [phase(r[x + 'B'], r[y + 'B']) for r in rs]; ph = [p for p in ph if p is not None]
    print(f"{x} mot {y}: n={len(rs)} tempo lika {c.get('lika', 0)} ({dict(c)}) | fas (samma oktav, n={len(ph)}): median {np.median(ph) if ph else '-'} i fas(>=0,8) {sum(1 for p in ph if p >= 0.8)} motfas(<=0,2) {sum(1 for p in ph if p <= 0.2)} mellan {sum(1 for p in ph if 0.2 < p < 0.8)}")
for ref in ('pc', 'a1', 'bt'):
    rs = [r for r in rows if r[ref] and r['cat']]
    if rs: print(f"{ref} mot katalogen: lika {sum(1 for r in rs if cls(r[ref], r['cat']) == 'lika')}/{len(rs)}")
# trippel: dar alla tre finns - majoritet
tri = [r for r in rows if r['pc'] and r['a1'] and r['bt']]
if tri:
    agree3 = sum(1 for r in tri if cls(r['pc'], r['a1']) == 'lika' and cls(r['bt'], r['a1']) == 'lika')
    print(f"alla tre finns: {len(tri)}; alla tre lika tempo: {agree3}; bt=a1 men pc avviker: {sum(1 for r in tri if cls(r['bt'], r['a1']) == 'lika' and cls(r['pc'], r['a1']) != 'lika')}; pc=a1 men bt avviker: {sum(1 for r in tri if cls(r['pc'], r['a1']) == 'lika' and cls(r['bt'], r['a1']) != 'lika')}")
    print("avvikare (namn, pc, a1, bt, katalog):")
    for r in tri:
        if not (cls(r['pc'], r['a1']) == 'lika' and cls(r['bt'], r['a1']) == 'lika'): print("  ", r['name'], round(r['pc'], 1), round(r['a1'], 1), round(r['bt'], 1), r['cat'] or '-')
