#!/usr/bin/env python3
"""NOBLE UTAN LOGGSKRÄP (2026-10-18, live-profil på lotus): noble bygger loggsträngar för VARJE BLE-paket även när loggningen är av -
t.ex. debug(`push to acl queue: ${first.toString('hex')}`) i hci.js gör om hela paketet till hex-text, och debug(...args) skapar
argumentlistan innan den ser att den är avstängd. Mätt live: ~100 kB/s av huvudtrådens skräp (V8 API 73 + debug 32).

Skriptet sätter `if (debug.enabled) ` framför varje sats som börjar med `debug(` i noble:s lib-filer (debug-paketets instans har
.enabled) - strängarna byggs då bara när loggningen faktiskt är på (DEBUG=...). Ingen annan logik ändras.
Idempotent; originalet sparas en gång som <fil>.orig-20261018; varje fil kontrolleras med `node --check` och återställs vid fel.
Körs PÅ Pi:n (som root, node_modules ägs av root), och igen efter varje `npm install` som skriver över noble:
  sudo python3 patch-noble-debug.py [--check] [--undo] [katalog]   (standard /opt/lotus-light/pi/node_modules/@stoprocent/noble/lib)
Motorn måste startas om efteråt (sudo systemctl restart lotus-light-engine).
"""
import os, re, shutil, subprocess, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
ROOT = args[0] if args else '/opt/lotus-light/pi/node_modules/@stoprocent/noble/lib'
CHECK, UNDO = '--check' in sys.argv, '--undo' in sys.argv
TAG = '.orig-20261018'
PAT = re.compile(r'^(\s*)debug\(', re.M)
GUARD = 'if (debug.enabled) debug('
tot = 0
for dp, _, fs in os.walk(ROOT):
    for f in fs:
        if not f.endswith('.js'):
            continue
        p = os.path.join(dp, f)
        s = open(p, encoding='utf-8').read()
        if UNDO:
            if os.path.exists(p + TAG):
                shutil.copy2(p + TAG, p); print('återställd', p)
            continue
        if not re.search(r"require\(['\"]debug['\"]\)", s):
            continue
        n = len(PAT.findall(s))
        if n == 0:
            continue
        if CHECK:
            print(f'{n:4d} oskyddade loggrader  {p}'); tot += n; continue
        if not os.path.exists(p + TAG):
            shutil.copy2(p, p + TAG)
        ns = PAT.sub(lambda m: m.group(1) + GUARD, s)
        open(p, 'w', encoding='utf-8').write(ns)
        r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
        if r.returncode != 0:
            shutil.copy2(p + TAG, p)
            sys.exit(f'SYNTAXFEL efter patch, återställd: {p}\n{r.stderr}')
        print(f'{n:4d} loggrader skyddade  {p}'); tot += n
print('totalt', tot)
