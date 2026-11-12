#!/usr/bin/env python3
# VAXLINGSVAKTEN (2026-11-12, agaren: "kor sa vi ger bra underlag till arenan"). Gar pa lotus-Pi:n en kvall.
# Laser motorns tempo ur /api/live varannan sekund. Nar klockan vaxlar tempo (>= 3 hopp > 12 % inom 60 s medan musik spelas)
# tas en rainspelning i full takt (48 kHz mono, 150 s) via /api/raw-capture, och motorns tempo loggas varje sekund bredvid.
# Filer: /home/pi/vaxling/v-<HHMMSS>.wav + .csv, loggen vakt.log. Slutar sjalv vid DEADLINE (argument: epoksekunder) eller efter MAXN.
# Ror inga installningar. Inspelaren (LOTUS_RECORDER) stangs av av en separat systemd-timer.
import json, os, sys, time, urllib.request

API = 'http://127.0.0.1:3051'
DIR = '/home/pi/vaxling'
DEADLINE = float(sys.argv[1])
MAXN = 12
os.makedirs(DIR, exist_ok=True)


def log(m):
    with open(DIR + '/vakt.log', 'a') as f:
        f.write(time.strftime('%H:%M:%S ') + m + '\n')


def call(path, method='GET', body=None, timeout=5, raw=False):
    req = urllib.request.Request(API + path, method=method, data=(json.dumps(body).encode() if body is not None else None),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = r.read()
    return d if raw else json.loads(d)


def live():
    try:
        d = call('/api/live', timeout=3)
    except Exception:
        return None
    b = d.get('beat') or {}
    s = d.get('section') or {}
    return {'playing': (d.get('sonos') or {}).get('playbackState', '').endswith('PLAYING') and (d.get('engine') or {}).get('running'),
            'bpm': b.get('bpm') or 0, 'lock': 1 if b.get('locked') else 0, 'conf': b.get('confidence') or 0, 'trust': b.get('trust') or 0,
            'lead': b.get('leadMs') or 0, 'eff': b.get('effekt') or '', 'sec': s.get('section') or '', 'lv': s.get('levelVsHighDb') or 0}


def capture(why):
    name = 'v-' + time.strftime('%H%M%S')
    try:
        r = call('/api/raw-capture/start', 'POST', {'seconds': 150, 'label': name, 'fullRate': True})
    except Exception as e:
        log('start misslyckades: %s' % e)
        return False
    if not r.get('seconds'):
        log('inspelaren svarar seconds 0 (LOTUS_RECORDER av?)')
        return False
    log('%s start (%s)' % (name, why))
    t0 = time.time()
    with open('%s/%s.csv' % (DIR, name), 'w') as f:
        f.write('t,bpm,lock,conf,trust,lead,eff,sec,lv\n')
        while time.time() - t0 < 153:
            l = live()
            if l:
                f.write('%.1f,%.1f,%d,%.2f,%.2f,%s,%s,%s,%.1f\n' % (time.time() - t0, l['bpm'], l['lock'], l['conf'], l['trust'], l['lead'], l['eff'], l['sec'], l['lv']))
                f.flush()
            time.sleep(1.0)
    try:
        wav = call('/api/raw-capture/wav', timeout=90, raw=True)
        with open('%s/%s.wav' % (DIR, name), 'wb') as f:
            f.write(wav)
        log('%s sparad %.1f MB' % (name, len(wav) / 1e6))
        return len(wav) > 1e6
    except Exception as e:
        log('%s kunde inte hamtas: %s' % (name, e))
        return False


log('vakten startad, slutar %s' % time.strftime('%d/%m %H:%M', time.localtime(DEADLINE)))
jumps = []
prev = 0.0
t_play = 0.0
n = 0
while time.time() < DEADLINE and n < MAXN:
    l = live()
    now = time.time()
    if not l or not l['playing'] or l['bpm'] <= 0:
        prev = 0.0
        jumps = []
        t_play = 0.0
        time.sleep(4)
        continue
    if t_play == 0.0:
        t_play = now
    # hopp = minst 12 % (syskontempon: 4:3 = 33 %, 3:2 = 50 %, dubbla = 100 %); smavingel kring ett tempo raknas inte.
    # De forsta 45 s efter att musiken/motorn startat raknas inte (klockan soker).
    if prev > 0 and now - t_play > 45 and abs(l['bpm'] / prev - 1) > 0.12:
        jumps.append((now, prev, l['bpm']))
    prev = l['bpm']
    jumps = [j for j in jumps if now - j[0] <= 60]
    if len(jumps) >= 3:
        if capture(' '.join('%.0f>%.0f' % (a, b) for _, a, b in jumps)):
            n += 1
        jumps = []
        prev = 0.0
        time.sleep(30)
        continue
    time.sleep(2)
log('vakten klar, %d inspelningar' % n)
