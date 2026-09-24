"""Ordnad deploy av enskilda filer ur pi/dist/ till Pi:n (samma stege som deploy-analyser-dir.py, 2026-09-21):
md5-diff per fil, upp till /tmp, node --check, backup <fil>.bak-<ts>, sudo cp, importtest av angivna moduler, EN omstart,
vanta pa API + BLE. Filerna anges relativt dist/ (t.ex. piEngine.js ble-driver/raster.js). Inga hemligheter i repot:
  PI_PASS=... [PI_HOST=192.168.1.174] python pi/scripts/deploy-dist-files.py [--dry] [--no-restart] [--import=ble-driver/raster.js] fil...
Bevisa forst att Pi:ns dist bara skiljer sig fran ett rent HEAD-bygge dar du vantar dig det (git stash -u; build; md5 mot Pi:n)."""
import hashlib, os, sys, time, paramiko
HOST = os.environ.get('PI_HOST', '192.168.1.174'); PW = os.environ.get('PI_PASS')
if not PW: sys.exit('PI_PASS saknas')
args = [a for a in sys.argv[1:] if not a.startswith('--')]
DRY = '--dry' in sys.argv; NORESTART = '--no-restart' in sys.argv
IMPORTS = [a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--import=')]
if not args: sys.exit('inga filer angivna')
HERE = os.path.dirname(os.path.abspath(__file__)); LOCAL = os.path.normpath(os.path.join(HERE, '..', 'dist'))
REMOTE = '/opt/lotus-light/pi/dist'
# GEMENSAM ANALYSATOR (2026-09-24): vagra INNAN nagot rors pa Pi:n om analysatorn/inspelaren skiljer sig fran den
# gemensamma (md5-manifestet i src/audio-analyser, och pi-dmx-kopian om den ar utcheckad bredvid). Se analyser_shared.py.
sys.path.insert(0, HERE); import analyser_shared
analyser_shared.check(os.path.join(HERE, '..', 'src', 'audio-analyser'), os.path.join(HERE, '..', '..', '..', 'dmx-control', 'pi-dmx', 'engine', 'src'), os.path.join(LOCAL, 'audio-analyser'))
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='pi', password=PW, timeout=15, look_for_keys=False, allow_agent=False)
def run(cmd, t=300):
    i, o, e = c.exec_command(cmd, timeout=t); rc = o.channel.recv_exit_status(); return rc, o.read().decode('utf-8', 'replace'), e.read().decode('utf-8', 'replace')
def sudo(cmd, t=300): return run(f"echo {PW} | sudo -S sh -c '{cmd}' 2>/dev/null", t)
files = {f: open(os.path.join(LOCAL, f), 'rb').read().replace(b'\r\n', b'\n') for f in args}
rc, out, _ = run(f"cd {REMOTE} && md5sum {' '.join(args)} 2>/dev/null"); remote = {l.split()[1]: l.split()[0] for l in out.splitlines() if len(l.split()) == 2}
todo = [f for f, d in files.items() if remote.get(f) != hashlib.md5(d).hexdigest()]
print(f"{len(files)} filer, skiljer/saknas pa Pi:n: {todo or 'inga'}")
if not todo or DRY: sys.exit(0)
ts = time.strftime('%Y%m%d-%H%M'); sf = c.open_sftp()
for f in todo:
    tmp = '/tmp/' + f.replace('/', '__')
    with sf.open(tmp, 'wb') as fh: fh.write(files[f])
    rc, out, err = run(f"node --check {tmp}")
    if rc: sys.exit(f"node --check {f} misslyckades: {err[:300]}")
    # mkdir -p (2026-09-23): en NY underkatalog (heartbeat/) saknades pa Pi:n -> cp foll tyst, piEngine.js pekade pa en modul som inte fanns.
    rc, out, _ = sudo(f"mkdir -p $(dirname {REMOTE}/{f}) && ([ -f {REMOTE}/{f} ] && cp {REMOTE}/{f} {REMOTE}/{f}.bak-{ts}; true) && cp {tmp} {REMOTE}/{f} && chown root:root {REMOTE}/{f} && chmod 644 {REMOTE}/{f} && ls -la {REMOTE}/{f}")
    if rc or not out.strip(): sys.exit(f"cp {f} misslyckades pa Pi:n - aterstall fran .bak-{ts} (deployade filer hittills kan peka pa saknade moduler)")
    print(out.strip())
for m in IMPORTS:
    rc, out, _ = run(f"cd /opt/lotus-light/pi && timeout 10 node -e \"import('{REMOTE}/{m}').then(()=>{{console.log('importtest ok {m}');process.exit(0)}}).catch(e=>{{console.log('IMPORTTEST FEL',e.message);process.exit(2)}})\"")
    print(out.strip())
    if rc: sys.exit('avbryter fore omstart - aterstall fran .bak-' + ts)
if NORESTART: print('ingen omstart begard'); sys.exit(0)
rc, out, _ = sudo("systemctl restart lotus-light-engine")
for i in range(60):
    time.sleep(2); rc, out, _ = run("systemctl is-active lotus-light-engine; curl -s -m 2 http://127.0.0.1:3051/api/status | head -c 200")
    if 'active' in out.split('\n')[0] and '"ok"' in out: print(f"motorn uppe efter {2*(i+1)} s"); break
else: sys.exit('motorn kom inte upp - se engine.log och aterstall fran .bak-' + ts)
for i in range(45):
    time.sleep(2); rc, out, _ = run("curl -s -m 2 http://127.0.0.1:3051/api/status | grep -oE '\"connected\":[0-9]+' | head -1")
    if out.strip().endswith(':1'): print(f"BLE ansluten efter {2*(i+1)} s"); break
else: print('BLE ej ansluten inom 90 s (normalt om Sonos ar IDLE)')
