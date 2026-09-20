"""Jamfor sparade omfacit-korningar (refacit-<tag>.json) mot katalogen (corpus/<id>.json 'catalog') och analysatorn (bank).
Taggen 'gammalt' = det sparade facit i korpusen (kolumnen old i forsta taggens fil).
  .venv\\Scripts\\python.exe compare.py gammalt evidens rigid1 ...   (taggar)"""
import glob, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))


def fold(b):
    while b > 180: b /= 2
    while 0 < b < 70: b *= 2
    return b


def cls(a, b):
    if not a or not b: return '-'
    r = a / b
    for x, lab in ((1, 'lika'), (2, 'dubbla'), (0.5, 'halva'), (1.5, '3/2'), (2 / 3, '2/3'), (4 / 3, '4/3'), (0.75, '3/4')):
        if abs(r / x - 1) < 0.05: return lab
    return 'annat'


cat = {}
for f in glob.glob(os.path.join(HERE, 'corpus', '*.json')):
    m = json.load(open(f, encoding='utf-8')); b = (m.get('catalog') or {}).get('bpm') or 0
    if b: cat[os.path.basename(f)] = fold(b)
tags = sys.argv[1:] or ['evidens']
real = [t for t in tags if t != 'gammalt'] or ['evidens']
runs = {t: {r['file']: r for r in json.load(open(os.path.join(HERE, f'refacit-{t}.json'), encoding='utf-8')) if r['set'] == 'korpus'} for t in real}
files = sorted(set.intersection(*[set(v) for v in runs.values()]))
print(f"{len(files)} latar; {sum(1 for f in files if f in cat)} med katalog")
print('lat'.ljust(40) + 'katalog'.ljust(9) + 'analys'.ljust(8) + ''.join((t + ' (~kat ~an)').ljust(24) for t in tags))
tot = {t: {'kat': 0, 'an': 0, 'n_an': 0, 'kat_an': 0} for t in tags}
for f in files:
    r0 = runs[real[0]][f]; c = cat.get(f, 0); a = r0.get('an') or 0
    line = r0['name'][:38].ljust(40) + (f"{c:.1f}" if c else '-').ljust(9) + (f"{a:.1f}" if a else '-').ljust(8)
    for t in tags:
        v = r0['old'] if t == 'gammalt' else runs[t][f]['new']
        kc, ac_ = cls(v, c), cls(v, a)
        tot[t]['kat'] += kc == 'lika'; tot[t]['an'] += ac_ == 'lika'; tot[t]['n_an'] += bool(a)
        line += f"{v:.1f} {kc} {ac_}".ljust(24)
    if f in cat: print(line)
nk = len(cat.keys() & set(files)); an_kat = sum(1 for f in files if f in cat and cls(runs[real[0]][f].get('an') or 0, cat[f]) == 'lika')
print(f"\nanalysatorn (bank) lika katalogen: {an_kat}/{nk}")
for t in tags: print(f"{t}: lika katalogen {tot[t]['kat']}/{nk}, lika analysatorn {tot[t]['an']}/{tot[t]['n_an']}")
