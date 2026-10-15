"""PROV LOTUS_BASS_BODY i kallaren (2026-10-15, a5e972d): nivan foljer baskroppen som DMX (pi/src/bassBody.ts).
  PA:  PI_PASS=... python pi/scripts/bass-body-prov.py        (LOTUS_BASS_BODY=2 = sub+kick 20-120 Hz, agarens val 10-15) deployar bassBody.js + analyser.js + piEngine.js (deploy-dist-files.py,
                                                               md5-diff, backup .bak-<ts>, node --check, importtest), lagger drop-in
                                                               lotus-light-engine.service.d/bass-body.conf, daemon-reload, EN omstart
  BAS: PI_PASS=... python pi/scripts/bass-body-prov.py --bodydb  som PA men LOTUS_BASS_BODY=1: hela baskroppen 20-250 Hz
  AV:  PI_PASS=... python pi/scripts/bass-body-prov.py --av   tar bort drop-in:en, daemon-reload, omstart - koden ligger kvar men ar
                                                               av (= exakt dagens vag; bara opt-in-grenen ar ny)
Verifierar efterat: tjanstens Environment, md5 for de tre filerna mot lokala pi/dist, och att API:t svarar. Inga hemligheter i repot."""
import hashlib, json, os, subprocess, sys, time, urllib.request, paramiko
HOST = os.environ.get('PI_HOST', '192.168.1.174'); PW = os.environ.get('PI_PASS')
if not PW: sys.exit('PI_PASS saknas')
AV = '--av' in sys.argv; BODY = '--bodydb' in sys.argv; SUB = not BODY
HERE = os.path.dirname(os.path.abspath(__file__)); DIST = os.path.normpath(os.path.join(HERE, '..', 'dist'))
FILES = ['bassBody.js', 'audio-analyser/analyser.js', 'piEngine.js']   # bassBody.js forst: piEngine.js importerar den
DROPIN_SRC = os.path.normpath(os.path.join(HERE, '..', 'system', 'systemd', 'lotus-light-engine.d.bass-body.conf'))
DROPIN = '/etc/systemd/system/lotus-light-engine.service.d/bass-body.conf'

if not AV:
    rc = subprocess.call([sys.executable, os.path.join(HERE, 'deploy-dist-files.py'), '--no-restart', '--import=piEngine.js'] + FILES, env=dict(os.environ))
    if rc: sys.exit(f'deploy-dist-files.py misslyckades ({rc}) - inget drop-in lagt, ingen omstart')

c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='pi', password=PW, timeout=15, look_for_keys=False, allow_agent=False)
def run(cmd, t=120):
    i, o, e = c.exec_command(cmd, timeout=t); rc = o.channel.recv_exit_status(); return rc, o.read().decode('utf-8', 'replace')
def sudo(cmd, t=120): return run(f"echo {PW} | sudo -S sh -c '{cmd}' 2>/dev/null", t)

if AV:
    rc, _ = sudo(f'rm -f {DROPIN} && systemctl daemon-reload && systemctl restart lotus-light-engine')
else:
    data = open(DROPIN_SRC, 'rb').read().replace(b'\r\n', b'\n')
    if BODY: data = data.replace(b'LOTUS_BASS_BODY=2', b'LOTUS_BASS_BODY=1')
    sf = c.open_sftp()
    with sf.open('/tmp/bass-body.conf', 'wb') as fh: fh.write(data)
    rc, _ = sudo(f'mkdir -p $(dirname {DROPIN}) && cp /tmp/bass-body.conf {DROPIN} && chmod 644 {DROPIN} && systemctl daemon-reload && systemctl restart lotus-light-engine')
if rc: sys.exit(f'sudo-steget misslyckades (rc {rc})')

ok = False
for _ in range(40):
    time.sleep(2)
    try:
        urllib.request.urlopen(f'http://{HOST}:3051/api/status', timeout=3).read(); ok = True; break
    except Exception: pass
_, env = run('systemctl show -p Environment lotus-light-engine')
_, act = run('systemctl is-active lotus-light-engine')
_, md5 = run('cd /opt/lotus-light/pi/dist && md5sum ' + ' '.join(FILES))
remote = {l.split()[1]: l.split()[0] for l in md5.splitlines() if len(l.split()) == 2}
local = {f: hashlib.md5(open(os.path.join(DIST, f), 'rb').read().replace(b'\r\n', b'\n')).hexdigest() for f in FILES}
on = ('LOTUS_BASS_BODY' if AV else 'LOTUS_BASS_BODY=2' if SUB else 'LOTUS_BASS_BODY=1') in env
print(f"tjanst: {act.strip()}, API svarar: {ok}, LOTUS_BASS_BODY i env: {on} (ska vara {not AV})")
for f in FILES: print(f"  {f}: {'= lokalt' if remote.get(f) == local[f] else 'SKILJER ' + str(remote.get(f))}")
sys.exit(0 if ok and act.strip() == 'active' and on == (not AV) else 1)
