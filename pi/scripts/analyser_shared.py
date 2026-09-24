"""GEMENSAM ANALYSATOR - deployspärr (2026-09-24). Samma fil i lotus-light-link (pi/scripts/) och dmx-control
(pi-dmx/engine/tools/). Analysatorn (analyser.ts, split.ts, slowWorker.ts, tempoTracker.ts) och inspelaren
(recorder.ts) ar SAMMA byte i bada repona; systemskillnaderna ligger i analyserProfile.ts (en per system).

check() vagrar (sys.exit) om:
  1. en gemensam fil lokalt inte har den md5 som star i manifestet ANALYSER_SHARED.md5 (i kallkatalogen),
  2. syskonrepots kopia (om den finns utcheckad) skiljer sig fran manifestet,
  3. bygget (dist) ar aldre an kallfilen (odistribuerad andring).
md5 raknas pa innehallet med CRLF -> LF (git autocrlf pa Windows far inte ge falsklarm).

Uppdatera manifestet EFTER att filerna kopierats till bada repona:
  python analyser_shared.py --write <kallkatalog>
Syskonets kallkatalog: env ANALYSER_SIBLING, annars standardplatsen bredvid detta repo."""
import hashlib, os, sys

SHARED = ['analyser.ts', 'split.ts', 'slowWorker.ts', 'tempoTracker.ts', 'recorder.ts']
MANIFEST = 'ANALYSER_SHARED.md5'


def md5_of(path):
    with open(path, 'rb') as f:
        return hashlib.md5(f.read().replace(b'\r\n', b'\n')).hexdigest()


def read_manifest(src):
    p = os.path.join(src, MANIFEST)
    if not os.path.exists(p): sys.exit(f'GEMENSAM ANALYSATOR: manifestet saknas ({p}) - deployar inget')
    out = {}
    for line in open(p, encoding='utf-8'):
        parts = line.split()
        if len(parts) == 2 and not line.startswith('#'): out[parts[1]] = parts[0]
    return out


def check(src, sibling=None, dist=None, dist_names=None):
    """src = denna repos kallkatalog for analysatorn, sibling = syskonrepots, dist = byggkatalogen (valfri)."""
    man = read_manifest(src)
    bad = []
    for f in SHARED:
        p = os.path.join(src, f)
        if not os.path.exists(p): bad.append(f'{f}: saknas lokalt'); continue
        if man.get(f) != md5_of(p): bad.append(f'{f}: lokal md5 {md5_of(p)[:12]} != gemensam {str(man.get(f))[:12]}')
    sib = os.environ.get('ANALYSER_SIBLING') or sibling
    if sib and os.path.isdir(sib):
        for f in SHARED:
            p = os.path.join(sib, f)
            if not os.path.exists(p): bad.append(f'{f}: saknas i syskonrepot ({sib})'); continue
            if man.get(f) != md5_of(p): bad.append(f'{f}: syskonrepots md5 {md5_of(p)[:12]} != gemensam {str(man.get(f))[:12]} ({sib})')
    if dist:
        for f in SHARED:
            js = os.path.join(dist, (dist_names or {}).get(f, f[:-3] + '.js'))
            if os.path.exists(js) and os.path.getmtime(js) < os.path.getmtime(os.path.join(src, f)):
                bad.append(f'{f}: bygget ({js}) ar aldre an kallfilen - bygg om')
    if bad:
        sys.exit('GEMENSAM ANALYSATOR SKILJER SIG - deployar inget:\n  ' + '\n  '.join(bad))
    print(f'gemensam analysator ok: {len(SHARED)} filer = manifestet' + (f' = syskonet ({sib})' if sib and os.path.isdir(sib) else ' (syskonrepot ej utcheckat)'))


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--write':
        src = sys.argv[2]
        with open(os.path.join(src, MANIFEST), 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('# md5 (CRLF->LF) av de gemensamma filerna - samma i lotus-light-link och dmx-control. Skrivs av analyser_shared.py --write\n')
            for f in SHARED: fh.write(f'{md5_of(os.path.join(src, f))} {f}\n')
        print(open(os.path.join(src, MANIFEST), encoding='utf-8').read())
    elif len(sys.argv) >= 2:
        check(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        sys.exit(__doc__)
