"""Rapport ur Pi:ns katalogcache: de senaste N laterna med PC-analys. Skriver HTML (artifact-sida) + JSON.
  .venv\Scripts\python.exe report.py [--n 10] [--findings findings.json] [--out rapport.html]
Forsta korningen 2026-09-19 (tio country-latar): findings-2026-09-19.json, publicerad som artifact
"Tio latar mot facit". Fynd: analysatorn ratt tempo 3/10 (fantom 3/2, 4/3: 4; halva: 1); gridet +13 ms median
nar tempot ar ratt; onset recall 0,5; nivakanal lag 250 ms r 0,4; oktavregeln 1/2 -> av."""
import json, sys, html, statistics as S, urllib.request, time, os
N = int(sys.argv[sys.argv.index('--n') + 1]) if '--n' in sys.argv else 10
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else os.path.join(os.path.dirname(__file__), 'rapport10.html')
FIND = json.load(open(sys.argv[sys.argv.index('--findings') + 1], encoding='utf-8')) if '--findings' in sys.argv else None
rows = json.load(urllib.request.urlopen('http://192.168.1.174:3051/api/tempo/cache', timeout=15))
pc = sorted([r for r in rows if r.get('pc') and r.get('pcAt')], key=lambda r: r['pcAt'])[-N:]
drops = [(r, d) for r in rows for d in (r.get('dropEvents') or [])]

def g(d, *ks, default=None):
    for k in ks:
        d = d.get(k) if isinstance(d, dict) else None
        if d is None: return default
    return d
def med(xs): xs = [x for x in xs if isinstance(x, (int, float))]; return round(S.median(xs), 1) if xs else None
def fmt(x, unit='', nd=1):
    if x is None or x == '': return '–'
    if isinstance(x, float): return f"{x:.{nd}f}{unit}".replace('.', ',')
    return f"{x}{unit}"
def cls(r):
    v = r.get('verdictEnd') or r.get('verdict') or ''
    an = g(r, 'learn', 'bpmMedian') or r.get('analyserBpm')
    if not r.get('bpm') or not an: return ('okänd', '')
    ratio = r['bpm'] / an
    for x, lab in ((1, 'lika'), (2, 'dubbla'), (0.5, 'halva'), (1.5, '3/2'), (2 / 3, '2/3'), (4 / 3, '4/3'), (0.75, '3/4')):
        if abs(ratio / x - 1) < 0.05: return (lab, f"{ratio:.2f}")
    return ('annat', f"{ratio:.2f}")

songs = []
for r in pc:
    p = r['pc']; ph, lv, on, dr, de, ln = p.get('phase') or {}, p.get('level') or {}, p.get('onset') or {}, p.get('drop') or {}, p.get('descr') or {}, r.get('learn') or {}
    c, ratio = cls(r)
    songs.append({
        'artist': r.get('artist', ''), 'title': r.get('title', ''), 'genre': r.get('genre') or '',
        'pcBpm': r.get('rawBpm') or r.get('bpm'), 'foldBpm': r.get('bpm'), 'anBpm': ln.get('bpmMedian') or r.get('analyserBpm'), 'anMin': ln.get('bpmMin'), 'anMax': ln.get('bpmMax'), 'conf': ln.get('confMedian'),
        'cls': c, 'ratio': ratio, 'pcConf': r.get('pcConf'), 'octave': (r.get('candidates') or [{}])[0].get('halfRatio') if r.get('candidates') else None,
        'kickMed': g(ph, 'kick', 'medianMs'), 'kickIqr': g(ph, 'kick', 'iqrMs'), 'kickN': g(ph, 'kick', 'onBeat'), 'kickOff': g(ph, 'kick', 'offBeatShare'),
        'pulseMed': g(ph, 'pulse', 'medianMs'), 'pulseIqr': g(ph, 'pulse', 'iqrMs'), 'pulseN': g(ph, 'pulse', 'onBeat'), 'lead': ph.get('leadMs'), 'gridBpm': ph.get('gridBpm'),
        'gridLag': ph.get('gridLagMs') if ph.get('gridLagMs') is not None else ((g(ph, 'pulse', 'medianMs') + (ph.get('leadMs') or 132)) if g(ph, 'pulse', 'medianMs') is not None else None),
        'lvLag': lv.get('lagMs'), 'lvR': lv.get('r'), 'brMin': lv.get('brightMin'), 'brMax': lv.get('brightMax'), 'audioDyn': lv.get('audioDynDb'),
        'onP': on.get('precision'), 'onR': on.get('recall'), 'onBias': on.get('biasMs'), 'onsets': on.get('onsets'), 'kicks': on.get('kicks'),
        'dropBest': dr.get('bestScore'), 'dropCands': len(dr.get('candidates') or []), 'rtDrops': len(dr.get('realtimeDropsAtS') or []),
        'centroid': de.get('centroidHz'), 'bass': de.get('bassRatio'), 'perc': de.get('percussive'), 'dyn': de.get('dynamicsDb'), 'ops': de.get('bassOnsetsPerS'),
        'ringPerBeat': ln.get('ringPerBeat'), 'ringReg': ln.get('ringRegular'), 'oct2x': ln.get('octave2x'), 'dur': ln.get('durationS'),
    })

agg = {
    'n': len(songs), 'pulseMed': med([s['pulseMed'] for s in songs]), 'pulseIqrMed': med([s['pulseIqr'] for s in songs]),
    'kickMed': med([s['kickMed'] for s in songs]), 'kickIqrMed': med([s['kickIqr'] for s in songs]), 'lead': songs[0]['lead'] if songs else 132,
    'onP': med([s['onP'] for s in songs]), 'onR': med([s['onR'] for s in songs]), 'onBias': med([s['onBias'] for s in songs]),
    'lvR': med([s['lvR'] for s in songs]), 'lvLag': med([s['lvLag'] for s in songs]),
    'cls': {c: sum(1 for s in songs if s['cls'] == c) for c in sorted(set(s['cls'] for s in songs))},
    'anSpread': med([(s['anMax'] - s['anMin']) for s in songs if s['anMax'] and s['anMin']]),
    'drops': {'n': len(drops), 'verdicts': {v: sum(1 for _, d in drops if d.get('verdict') == v) for v in sorted(set(d.get('verdict') or '–' for _, d in drops))}},
    'songs': [f"{s['artist']} – {s['title']}" for s in songs],
}
agg['gridLagMs'] = med([s['gridLag'] for s in songs])   # +x => gridet x ms sent (pulserna fyrar -lead om gridet ar ratt)
json.dump({'agg': agg, 'songs': songs}, open(OUT.replace('.html', '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(agg, ensure_ascii=False, indent=1))

# ───────────── HTML ─────────────
def e(x): return html.escape(str(x))
def dotplot(songs):
    x0, x1 = -220, 60; W, L, R, rowh, top = 860, 250, 30, 26, 34
    Hh = top + rowh * len(songs) + 40
    sx = lambda v: L + (v - x0) / (x1 - x0) * (W - L - R)
    out = [f'<svg viewBox="0 0 {W} {Hh}" width="100%" role="img" aria-label="Pulsfyrning och kickar per låt mot PC:ns slag">']
    for t in range(-200, 61, 50):
        out.append(f'<line x1="{sx(t):.1f}" y1="{top-8}" x2="{sx(t):.1f}" y2="{Hh-30}" stroke="var(--rule)" stroke-width="1"/>')
        out.append(f'<text x="{sx(t):.1f}" y="{Hh-12}" text-anchor="middle" class="tick">{t:+d} ms</text>')
    lead = songs[0]['lead'] if songs and songs[0]['lead'] else 132
    out.append(f'<line x1="{sx(0):.1f}" y1="{top-8}" x2="{sx(0):.1f}" y2="{Hh-30}" stroke="var(--ink)" stroke-width="1.5"/>')
    out.append(f'<text x="{sx(0)+4:.1f}" y="{top-12}" class="tick">slaget</text>')
    out.append(f'<line x1="{sx(-lead):.1f}" y1="{top-8}" x2="{sx(-lead):.1f}" y2="{Hh-30}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>')
    out.append(f'<text x="{sx(-lead)+4:.1f}" y="{top-12}" class="tick" fill="var(--accent)">lead −{lead}</text>')
    for i, s in enumerate(songs):
        y = top + i * rowh + rowh / 2
        name = f"{s['artist']} – {s['title']}"; name = name if len(name) <= 30 else name[:29] + '…'
        out.append(f'<text x="{L-8}" y="{y+4:.1f}" text-anchor="end" class="lbl">{e(name)}</text>')
        if s['pulseMed'] is not None:
            iq = s['pulseIqr'] or 0
            out.append(f'<line x1="{sx(max(x0, s["pulseMed"]-iq/2)):.1f}" y1="{y:.1f}" x2="{sx(min(x1, s["pulseMed"]+iq/2)):.1f}" y2="{y:.1f}" stroke="var(--warn)" stroke-width="3" opacity="0.45"/>')
            out.append(f'<circle cx="{sx(s["pulseMed"]):.1f}" cy="{y:.1f}" r="5" fill="var(--warn)"/>')
        if s['kickMed'] is not None:
            out.append(f'<circle cx="{sx(s["kickMed"]):.1f}" cy="{y:.1f}" r="4.5" fill="var(--paper)" stroke="var(--accent)" stroke-width="2"/>')
    out.append('</svg>')
    return '\n'.join(out)
def bars(songs):
    W, L, R, rowh, top = 860, 250, 30, 24, 14; Hh = top + rowh * len(songs) + 30
    sx = lambda v: L + v * (W - L - R)
    out = [f'<svg viewBox="0 0 {W} {Hh}" width="100%" role="img" aria-label="Onset precision och recall per låt">']
    for t in (0, 0.25, 0.5, 0.75, 1):
        out.append(f'<line x1="{sx(t):.1f}" y1="{top-4}" x2="{sx(t):.1f}" y2="{Hh-22}" stroke="var(--rule)"/>'); out.append(f'<text x="{sx(t):.1f}" y="{Hh-6}" text-anchor="middle" class="tick">{int(t*100)} %</text>')
    for i, s in enumerate(songs):
        y = top + i * rowh; name = f"{s['title']}"; name = name if len(name) <= 30 else name[:29] + '…'
        out.append(f'<text x="{L-8}" y="{y+15}" text-anchor="end" class="lbl">{e(name)}</text>')
        if s['onP'] is not None: out.append(f'<rect x="{L}" y="{y+3}" width="{sx(s["onP"])-L:.1f}" height="7" fill="var(--accent)"/>')
        if s['onR'] is not None: out.append(f'<rect x="{L}" y="{y+12}" width="{sx(s["onR"])-L:.1f}" height="7" fill="var(--warn)"/>')
    out.append('</svg>')
    return '\n'.join(out)

def trow(cells, head=False):
    tag = 'th' if head else 'td'
    return '<tr>' + ''.join(f'<{tag}>{c}</{tag}>' for c in cells) + '</tr>'
t_tempo = '\n'.join([trow(['Låt', 'PC-facit', 'Analysator (median, spann)', 'Klass', 'Kvot', 'Ring/slag', 'Regelb.', 'Genre'], True)] + [
    trow([f"{e(s['artist'])} – {e(s['title'])}", fmt(s['pcBpm']), f"{fmt(s['anBpm'], nd=0)} ({fmt(s['anMin'], nd=0)}–{fmt(s['anMax'], nd=0)})", e(s['cls']), e(s['ratio']), fmt(s['ringPerBeat'], nd=2), fmt(s['ringReg'], nd=2), e(s['genre'] or '–')]) for s in songs])
t_phase = '\n'.join([trow(['Låt', 'Kick vs slag', 'IQR', 'n', 'Off-beat-andel', 'Puls fyrar', 'IQR', 'n', 'Grid vs slag'], True)] + [
    trow([e(s['title']), fmt(s['kickMed'], ' ms'), fmt(s['kickIqr'], ' ms'), fmt(s['kickN']), fmt(s['kickOff'], nd=2), fmt(s['pulseMed'], ' ms'), fmt(s['pulseIqr'], ' ms'), fmt(s['pulseN']), fmt(s['gridLag'], ' ms')]) for s in songs])
t_level = '\n'.join([trow(['Låt', 'Nivå-lag', 'r', 'Ljus min–max', 'Ljud dyn (5–95 %)', 'Onset precision', 'recall', 'bias', 'PC-onsets', 'kickar'], True)] + [
    trow([e(s['title']), fmt(s['lvLag'], ' ms', nd=0), fmt(s['lvR'], nd=2), f"{fmt(s['brMin'], nd=2)}–{fmt(s['brMax'], nd=2)}", fmt(s['audioDyn'], ' dB'), fmt(s['onP'], nd=2), fmt(s['onR'], nd=2), fmt(s['onBias'], ' ms'), fmt(s['onsets']), fmt(s['kicks'])]) for s in songs])
t_descr = '\n'.join([trow(['Låt', 'Tyngdpunkt', 'Basandel', 'Perkussivt', 'Dynamik', 'Basonsets/s', 'Drop-score (tempo-snutt)', 'RT-drops i fönstret'], True)] + [
    trow([e(s['title']), fmt(s['centroid'], ' Hz'), fmt(s['bass'], nd=3), fmt(s['perc'], nd=2), fmt(s['dyn'], ' dB'), fmt(s['ops'], nd=2), fmt(s['dropBest'], nd=2), fmt(s['rtDrops'])]) for s in songs])
t_drops = '\n'.join([trow(['Låt', 'Dom', 'Score nära händelsen', 'Bästa steg', 'vid', 'Puls vs slag'], True)] + [
    trow([e(r.get('title', '')), e(d.get('verdict', '–')), fmt(d.get('nearScore'), nd=2), fmt(d.get('bestScore'), nd=2), fmt(d.get('bestAtS'), ' s'), fmt(g(d, 'phase', 'pulse', 'medianMs'), ' ms')]) for r, d in drops[-12:]]) if drops else '<tr><td colspan="6">Inga dropfångster under fönstret.</td></tr>'

find = FIND or {'summary': [], 'findings': [], 'next': []}
li = lambda xs: ''.join(f'<li>{x}</li>' for x in xs)
key = lambda lab, val, sub='': f'<div class="kpi"><div class="kv">{val}</div><div class="kl">{lab}</div><div class="ks">{sub}</div></div>'
grid_lag = agg.get('gridLagMs')
page = f"""<title>Tio låtar mot facit</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{{--paper:#F5F7F9;--ink:#1B2430;--muted:#5F6E7E;--rule:#D9E0E7;--accent:#0F766E;--warn:#C2410C;--tile:#FFFFFF;--soft:#E8EEF2}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--paper:#10161C;--ink:#E6ECF2;--muted:#94A3B8;--rule:#273240;--accent:#2DD4BF;--warn:#FB923C;--tile:#161E26;--soft:#1C2630}}}}
:root[data-theme="dark"]{{--paper:#10161C;--ink:#E6ECF2;--muted:#94A3B8;--rule:#273240;--accent:#2DD4BF;--warn:#FB923C;--tile:#161E26;--soft:#1C2630}}
body{{background:var(--paper);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:15px;line-height:1.55;padding-block:32px 64px;padding-inline:16px}}
main{{max-width:960px;margin:0 auto}}
h1,h2,h3{{font-family:"IBM Plex Sans Condensed","Arial Narrow",sans-serif;text-wrap:balance;margin:0}}
h1{{font-size:2.4rem;line-height:1.05;font-weight:700}} h2{{font-size:1.35rem;margin-top:44px;padding-top:14px;border-top:2px solid var(--ink)}} h3{{font-size:1.05rem;margin-top:22px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}}
.eyebrow{{font-family:"IBM Plex Mono",monospace;font-size:.8rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}}
.lede{{max-width:64ch;color:var(--muted);margin-top:10px}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:22px}}
.kpi{{background:var(--tile);border:1px solid var(--rule);padding:14px 16px}} .kv{{font-family:"IBM Plex Mono",monospace;font-size:1.7rem;font-weight:500;font-variant-numeric:tabular-nums}} .kl{{font-size:.85rem;margin-top:2px}} .ks{{font-size:.78rem;color:var(--muted)}}
p{{max-width:68ch}} ul{{max-width:70ch;padding-left:1.2em}} li{{margin:6px 0}}
.wrap{{overflow-x:auto;margin-top:12px}} table{{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums}} th,td{{text-align:left;padding:6px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}} th{{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:.75rem;color:var(--muted);letter-spacing:.04em}} td:first-child{{white-space:normal;min-width:180px}}
.fig{{background:var(--tile);border:1px solid var(--rule);padding:12px;margin-top:12px}} .fig svg{{display:block;height:auto}} .tick{{font-family:"IBM Plex Mono",monospace;font-size:11px;fill:var(--muted)}} .lbl{{font-size:12px;fill:var(--ink)}}
.legend{{display:flex;gap:18px;flex-wrap:wrap;font-size:.82rem;color:var(--muted);margin-top:8px}} .sw{{display:inline-block;width:12px;height:12px;vertical-align:-1px;margin-right:6px}}
.mono{{font-family:"IBM Plex Mono",monospace}}
</style>
<main>
<div class="eyebrow">lotus-light · facit ur ljudet · {time.strftime('%Y-%m-%d %H:%M')}</div>
<h1>Tio låtar mot facit</h1>
<p class="lede">Vad realtidsanalysatorn och ljuset gjorde under {agg['n']} låtar, dömt i efterhand av PC:n på samma 48 kHz-ljud. Alla tider är millisekunder mot PC:ns slag; negativt betyder före slaget.</p>
<div class="kpis">
{key('gridets släp mot slaget', fmt(grid_lag, ' ms'), f'puls fyrar {fmt(agg["pulseMed"], " ms")} mot lead −{agg["lead"]}')}
{key('analysatorns kickar', fmt(agg['kickMed'], ' ms'), f'IQR-median {fmt(agg["kickIqrMed"], " ms")}')}
{key('onset recall', fmt(agg['onR'], nd=2), f'precision {fmt(agg["onP"], nd=2)}, bias {fmt(agg["onBias"], " ms")}')}
{key('ljus mot ljud', fmt(agg['lvR'], nd=2), f'lag {fmt(agg["lvLag"], " ms", nd=0)}')}
{key('analysatorns tempospann', fmt(agg['anSpread'], ' BPM', nd=0), 'median över låt')}
{key('dropfångster', fmt(agg['drops']['n']), ', '.join(f'{k} {v}' for k, v in agg['drops']['verdicts'].items()) or '–')}
</div>

<h2>Sammanfattning</h2>
<ul>{li(find.get('summary', []))}</ul>

<h2>Slagfas: var kickar och pulser landar</h2>
<p>Fylld punkt = gridpulsens fyrtid (median av on-beat-pulser, streck = kvartilavstånd). Ring = analysatorns kicktid. Streckad linje = var pulsen <em>ska</em> fyra om gridet vore rätt (lead −{agg['lead']}). Avståndet mellan punkt och streckad linje är gridets släp.</p>
<div class="fig">{dotplot(songs)}<div class="legend"><span><span class="sw" style="background:var(--warn)"></span>puls fyrar</span><span><span class="sw" style="border:2px solid var(--accent);box-sizing:border-box"></span>kick (analysator)</span></div></div>
<div class="wrap"><table>{t_phase}</table></div>

<h2>Tempo: PC-facit mot analysatorn</h2>
<div class="wrap"><table>{t_tempo}</table></div>

<h2>Styrkekanalen och onset-detektorn</h2>
<p>Nivå-lag och r: korskorrelation mellan lampans skickade ljusstyrka (10 Hz) och ljudets RMS. Onset: PC:ns basonsets (under 220 Hz) mot analysatorns kick-ring inom 50 ms.</p>
<div class="fig">{bars(songs)}<div class="legend"><span><span class="sw" style="background:var(--accent)"></span>precision</span><span><span class="sw" style="background:var(--warn)"></span>recall</span></div></div>
<div class="wrap"><table>{t_level}</table></div>

<h2>Drops</h2>
<div class="wrap"><table>{t_drops}</table></div>

<h2>Vilken sorts musik</h2>
<div class="wrap"><table>{t_descr}</table></div>

<h2>Fynd</h2>
<ul>{li(find.get('findings', []))}</ul>

<h2>Nästa steg</h2>
<ul>{li(find.get('next', []))}</ul>

<h3>Metod</h3>
<p>Pi:n fångar 30 s @48 kHz tio sekunder in i varje låt (dropfångster: 15 s före + 15 s efter händelsen) och loggar samtidigt kick-ringen, gridpulsernas fyrtider, ljusstyrkan och detektorflaggorna i väggklocka. PC:n väljer tempo på evidens (kandidater pinnas, basonset på slagen, halvslagstest för oktav), lägger ut slagen och räknar fas, nivåkorrelation, onset-träffar, dropscore och deskriptorer. Allt sparas i <span class="mono">tempo-cache.json</span> på Pi:n.</p>
</main>
"""
open(OUT, 'w', encoding='utf-8').write(page)
print('skrev', OUT, 'och', OUT.replace('.html', '.json'))
