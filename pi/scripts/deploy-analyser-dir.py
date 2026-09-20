"""ORDNAD deploy av root-agda pi/dist/audio-analyser/ till Pi:n (laxa 13, 2026-09-20): bygget importerar syskonmoduler
(tempoTracker.js), sa HELA katalogen synkas - inte bara analyser.js. Steg: md5-diff per *.js, upp till /tmp, node --check,
backup <fil>.bak-<ts>, sudo cp, importtest av analyser.js pa Pi:n, EN omstart, vanta pa API + BLE. Inga hemligheter i repot:
  PI_PASS=... [PI_HOST=192.168.1.174] python pi/scripts/deploy-analyser-dir.py [--dry]
Standardbygget ska vara beteendeidentiskt (nya vagar opt-in via env i tempo-variant.conf); bevisa det i korbanken forst."""
import hashlib, os, sys, time, paramiko
HOST = os.environ.get('PI_HOST', '192.168.1.174'); PW = os.environ.get('PI_PASS'); DRY = '--dry' in sys.argv
if not PW: sys.exit('PI_PASS saknas')
HERE = os.path.dirname(os.path.abspath(__file__)); LOCAL = os.path.normpath(os.path.join(HERE, '..', 'dist', 'audio-analyser'))
REMOTE = '/opt/lotus-light/pi/dist/audio-analyser'
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='pi', password=PW, timeout=15, look_for_keys=False, allow_agent=False)
def run(cmd, t=300):
    i, o, e = c.exec_command(cmd, timeout=t); rc = o.channel.recv_exit_status(); return rc, o.read().decode('utf-8', 'replace'), e.read().decode('utf-8', 'replace')
def sudo(cmd, t=300): return run(f"echo {PW} | sudo -S sh -c '{cmd}' 2>/dev/null", t)
files = {f: open(os.path.join(LOCAL, f), 'rb').read().replace(b'\r\n', b'\n') for f in os.listdir(LOCAL) if f.endswith('.js')}
rc, out, _ = run(f"cd {REMOTE} && md5sum *.js 2>/dev/null"); remote = {l.split()[1]: l.split()[0] for l in out.splitlines() if len(l.split()) == 2}
todo = [f for f, d in files.items() if remote.get(f) != hashlib.md5(d).hexdigest()]
print(f"lokalt {len(files)} filer, skiljer/saknas pa Pi:n: {todo or 'inga'}")
if not todo or DRY: sys.exit(0)
ts = time.strftime('%Y%m%d-%H%M'); sf = c.open_sftp()
for f in todo:
    with sf.open(f"/tmp/{f}", 'wb') as fh: fh.write(files[f])
    rc, out, err = run(f"node --check /tmp/{f}")
    if rc: sys.exit(f"node --check {f} misslyckades: {err[:300]}")
    rc, out, _ = sudo(f"[ -f {REMOTE}/{f} ] && cp {REMOTE}/{f} {REMOTE}/{f}.bak-{ts}; cp /tmp/{f} {REMOTE}/{f} && chown root:root {REMOTE}/{f} && chmod 644 {REMOTE}/{f} && ls -la {REMOTE}/{f}")
    print(out.strip())
rc, out, _ = run(f"cd /opt/lotus-light/pi && timeout 10 node -e \"import('{REMOTE}/analyser.js').then(()=>{{console.log('importtest ok');process.exit(0)}}).catch(e=>{{console.log('IMPORTTEST FEL',e.message);process.exit(2)}})\"")
print(out.strip())
if rc: sys.exit('avbryter fore omstart - aterstall fran .bak-' + ts)
rc, out, _ = sudo("systemctl restart lotus-light-engine")
for i in range(60):
    time.sleep(2); rc, out, _ = run("systemctl is-active lotus-light-engine; curl -s -m 2 http://127.0.0.1:3051/api/status | head -c 200")
    if 'active' in out.split('\n')[0] and '"ok"' in out: print(f"motorn uppe efter {2*(i+1)} s"); break
else: sys.exit('motorn kom inte upp - se engine.log och aterstall fran .bak-' + ts)
for i in range(45):
    time.sleep(2); rc, out, _ = run("curl -s -m 2 http://127.0.0.1:3051/api/status | grep -oE '\"connected\":[0-9]+' | head -1")
    if out.strip().endswith(':1'): print(f"BLE ansluten efter {2*(i+1)} s"); break
else: print('BLE ej ansluten inom 90 s (normalt om Sonos ar IDLE)')
