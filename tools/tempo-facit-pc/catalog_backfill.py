"""Katalogtempo (Deezer) for korpusen som OBEROENDE referens till PC-facit (2026-09-20). Pi:ns tempoLookup.ts gor samma
uppslagning live, men PC-facit skriver over katalogvardet i cachen (source 'pc:...'), sa referensen forsvann. Har sparas den
i corpus/<id>.json under 'catalog' ({bpm, rawBpm, match, score}); bpm 0 = ingen traff. Kors om med --force.
  .venv\Scripts\python.exe catalog_backfill.py [--force]"""
import glob, json, os, re, sys, time, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); FORCE = '--force' in sys.argv

def norm(s): return re.sub(r'[^a-z0-9 ]', ' ', re.sub(r'\(.*?\)|\[.*?\]|\s-\s.*$', ' ', (s or '').lower())).split()
def dice(a, b):
    A, B = set(a), set(b)
    return 2 * len(A & B) / (len(A) + len(B)) if A and B else 0.0
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'lotus-facit/1'}), timeout=15) as r: return json.load(r)

def lookup(artist, title):
    q = f'artist:"{artist}" track:"{title}"' if artist else title
    try: d = get('https://api.deezer.com/search?limit=10&q=' + urllib.parse.quote(q))
    except Exception as e: return {'bpm': 0, 'error': str(e)[:80]}
    data = d.get('data') or []
    if not data and artist:                                        # fallback: fri text
        try: data = (get('https://api.deezer.com/search?limit=10&q=' + urllib.parse.quote(f'{artist} {title}')) or {}).get('data') or []
        except Exception: data = []
    cands = sorted(({'id': t['id'], 't': t.get('title', ''), 'a': (t.get('artist') or {}).get('name', ''),
                     'score': 0.6 * dice(norm(title), norm(t.get('title', ''))) + 0.4 * dice(norm(artist), norm((t.get('artist') or {}).get('name', '')))}
                    for t in data), key=lambda c: -c['score'])
    for c in cands[:4]:
        if c['score'] < 0.5: break
        try: t = get(f"https://api.deezer.com/track/{c['id']}"); time.sleep(0.25)
        except Exception: continue
        bpm = float(t.get('bpm') or 0)
        if 40 < bpm < 300: return {'bpm': bpm, 'rawBpm': bpm, 'match': f"{c['a']} - {c['t']}", 'score': round(c['score'], 2), 'source': 'deezer'}
    return {'bpm': 0, 'best': (f"{cands[0]['a']} - {cands[0]['t']} ({cands[0]['score']:.2f})" if cands else 'ingen traff')}

n = hit = 0
for f in sorted(glob.glob(os.path.join(HERE, 'corpus', '*.json'))):
    m = json.load(open(f, encoding='utf-8'))
    if m.get('catalog') and not FORCE: hit += 1 if m['catalog'].get('bpm') else 0; n += 1; continue
    row = m.get('row') or {}
    c = lookup(row.get('artist', ''), row.get('title', '')); c['at'] = int(time.time())
    m['catalog'] = c; json.dump(m, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
    n += 1; hit += 1 if c.get('bpm') else 0
    print(f"{row.get('artist','')[:22]:22} - {row.get('title','')[:28]:28} -> {c.get('bpm') or '-'} {c.get('match') or c.get('best') or c.get('error') or ''}"[:120], flush=True)
    time.sleep(0.4)
print(f"klart: {hit}/{n} med katalog-bpm")
