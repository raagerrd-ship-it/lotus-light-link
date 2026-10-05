"""Fryst latlista for korbanken (2026-10-05). Skriver bench-manifest.txt = de korpusfiler bankens tempovarianter ska koras pa.

Varfor: korpusen ar ett rullande fonster (CORPUS_MAX_WAV gallrar aldsta WAV, nya snuttar roterar in), sa bankens siffror flyttar
sig utan kodandring och dygn gar inte att jamfora (matfalla 38: taket; matfalla 39: 61 Alfons Aberg-ljudbocker 10-04 -> live
451/567 -> 400/572). Listan fryses och skyddas mot gallring (tempo_facit.py), nattjobbet satter BENCH_MANIFEST.

Urval: WAV finns, inte brus/kvalitetsfel, tempofacit > 0 OCH Beat This! har rostat (result.voteClass satt). Ljudbockerna saknar
rosten 59/60 (tal - ingen puls att hora), musiken 10/512. Det ar facit-sidans egen bekraftelse, ingen trosklad pa analysatorn.

  .venv\\Scripts\\python.exe bench_manifest.py [--dry]    (skriver aldrig over en befintlig lista utan --force)"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.environ.get('LOTUS_CORPUS_DIR') or os.path.join(HERE, 'corpus')
OUT = os.path.join(HERE, 'bench-manifest.txt')


def pick():
    keep, why = [], {}
    for f in sorted(os.listdir(CORPUS)):
        if not f.endswith('.json'): continue
        if not os.path.exists(os.path.join(CORPUS, f[:-5] + '.wav')): why['ingen wav'] = why.get('ingen wav', 0) + 1; continue
        try: r = json.load(open(os.path.join(CORPUS, f), encoding='utf-8')).get('result') or {}
        except Exception: why['trasig json'] = why.get('trasig json', 0) + 1; continue
        if r.get('method') == 'brus' or (r.get('quality') or {}).get('ok') is False: why['brus'] = why.get('brus', 0) + 1; continue
        if not r.get('bpm'): why['inget tempofacit'] = why.get('inget tempofacit', 0) + 1; continue
        if not r.get('voteClass'): why['ingen Beat This!-rost'] = why.get('ingen Beat This!-rost', 0) + 1; continue
        keep.append(f)
    return keep, why


if __name__ == '__main__':
    keep, why = pick()
    print(f'{len(keep)} filer i listan, bortvalda {why}')
    if '--dry' in sys.argv: sys.exit(0)
    if os.path.exists(OUT) and '--force' not in sys.argv: sys.exit(f'{OUT} finns redan - listan ar fryst (--force for att bygga om, ny baslinje)')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f: f.write('\n'.join(keep) + '\n')
    print('skrev', OUT)
