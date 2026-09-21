"""Analys av en V8 .cpuprofile fran motorn (POST /api/debug/cpuprofile?ms=N pa Pi:n, 2026-09-21 stall-jakten).
  python cpuprofile_top.py <fil.cpuprofile> [--top 25] [--stall 40]
Skriver: (1) topp-funktioner efter EGEN tid (self) och total tid, (2) langsta sammanhangande block dar samma
funktion (eller samma stack-rot) holl traden > --stall ms = det som gor ticken sen, med stacken for varje block."""
import json, sys, collections
f = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
if not f: sys.exit(__doc__)
TOP = int(next((a.split('=')[1] for a in sys.argv if a.startswith('--top=')), 25))
STALL = float(next((a.split('=')[1] for a in sys.argv if a.startswith('--stall=')), 40))
p = json.load(open(f, encoding='utf-8'))
nodes = {n['id']: n for n in p['nodes']}
parent = {}
for n in p['nodes']:
    for c in n.get('children', []): parent[c] = n['id']
def name(nid):
    cf = nodes[nid]['callFrame']; fn = cf.get('functionName') or '(anonym)'
    url = (cf.get('url') or '').split('/')[-1]; return f"{fn} {url}:{cf.get('lineNumber', 0) + 1}" if url else fn
def stack(nid, depth=8):
    out = []
    while nid in nodes and len(out) < depth:
        out.append(name(nid)); nid = parent.get(nid)
        if nid is None: break
    return out
samples = p['samples']; deltas = p['timeDeltas']
tot = sum(deltas) / 1000
self_ms = collections.Counter(); total_ms = collections.Counter()
for s, d in zip(samples, deltas):
    ms = d / 1000; self_ms[s] += ms
    seen = set(); n = s
    while n is not None and n not in seen:
        seen.add(n); total_ms[n] += ms; n = parent.get(n)
print(f"profil {tot / 1000:.1f} s, {len(samples)} prov, intervall {p['endTime'] and (p['endTime'] - p['startTime']) / max(1, len(samples)) / 1000:.2f} ms")
agg_self = collections.Counter(); agg_tot = collections.Counter()
for nid, ms in self_ms.items(): agg_self[name(nid)] += ms
for nid, ms in total_ms.items(): agg_tot[name(nid)] += ms
print("\n== topp egen tid (ms, andel) ==")
for k, v in agg_self.most_common(TOP): print(f"{v:8.0f} {100 * v / tot:5.1f}%  {k}")
# Stall-block: sammanhangande prov dar toppen av stacken INTE ar (idle)/(program)/(garbage collector)
idle = {nid for nid in nodes if nodes[nid]['callFrame'].get('functionName') in ('(idle)', '(program)')}
blocks = []; cur = None
for s, d in zip(samples, deltas):
    ms = d / 1000
    if s in idle:
        if cur: blocks.append(cur); cur = None
        continue
    if cur is None: cur = {'ms': 0, 'tops': collections.Counter()}
    cur['ms'] += ms; cur['tops'][s] += ms
if cur: blocks.append(cur)
long = sorted((b for b in blocks if b['ms'] >= STALL), key=lambda b: -b['ms'])
print(f"\n== sammanhangande block utan idle >= {STALL:.0f} ms: {len(long)} st (langsta forst) ==")
for b in long[:12]:
    print(f"\n-- {b['ms']:.0f} ms --")
    for nid, ms in b['tops'].most_common(4):
        print(f"   {ms:6.0f} ms  " + ' <- '.join(stack(nid, 6)))
